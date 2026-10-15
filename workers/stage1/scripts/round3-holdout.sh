#!/bin/bash
# M2 3차 봉인 보류셋을 사전 검사부터 최종 판정까지 한 번에 실행한다.

set -euo pipefail

if [ "$#" -ne 7 ]; then
  echo "사용법: $0 MANIFEST HOLDOUT RULE_TOOL KEYWORDS_OR_DASH STAGE2_MODEL_DIR DATA_DIR OUTPUT_DIR" >&2
  exit 2
fi

current_stage=arguments
temporary_dir=
publish_dir=
preflight_reason=
preflight_reason_file=
cleanup() {
  if [ -n "$publish_dir" ] && [ -d "$publish_dir" ]; then
    rm -rf -- "$publish_dir"
  fi
  if [ -n "$temporary_dir" ] && [ -d "$temporary_dir" ]; then
    rm -rf -- "$temporary_dir"
  fi
}
on_error() {
  local status=$?
  local reason=$preflight_reason
  trap - ERR
  if [ "$current_stage" = preflight ] && [ -n "$preflight_reason_file" ] && [ -s "$preflight_reason_file" ]; then
    IFS= read -r reason <"$preflight_reason_file" || true
  fi
  if [ "$current_stage" = preflight ] && [ -n "$reason" ]; then
    printf 'preflight: %s\n' "$reason" >&2
  else
    printf '%s\n' "$current_stage" >&2
  fi
  cleanup
  exit "$status"
}
trap on_error ERR
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

absolute_existing() {
  local input=$1
  local parent
  CDPATH= cd -- "$(dirname -- "$input")" 2>/dev/null || return 1
  parent=$(pwd -P) || return 1
  printf '%s/%s\n' "$parent" "$(basename -- "$input")"
}

absolute_output() {
  local input=$1
  local parent
  CDPATH= cd -- "$(dirname -- "$input")" 2>/dev/null || return 1
  parent=$(pwd -P) || return 1
  printf '%s/%s\n' "$parent" "$(basename -- "$input")"
}

abort_preflight() {
  preflight_reason=$1
  return 1
}

current_stage=preflight
manifest_path=$(absolute_existing "$1") || abort_preflight missing_input
holdout_path=$(absolute_existing "$2") || abort_preflight missing_input
rule_tool_path=$(absolute_existing "$3") || abort_preflight missing_input
if [ "$4" = "-" ]; then
  keywords_path=-
else
  keywords_path=$(absolute_existing "$4") || abort_preflight missing_input
fi
stage2_model_dir=$(absolute_existing "$5") || abort_preflight missing_input
data_dir=$(absolute_existing "$6") || abort_preflight missing_input
output_dir=$(absolute_output "$7") || abort_preflight output_parent_missing
output_parent=$(dirname -- "$output_dir")
output_name=$(basename -- "$output_dir")

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P) || abort_preflight script_path_invalid
stage1_dir=$(CDPATH= cd -- "$script_dir/.." && pwd -P) || abort_preflight script_path_invalid
repo_root=$(CDPATH= cd -- "$stage1_dir/../.." && pwd -P) || abort_preflight script_path_invalid
stage2_dir="$repo_root/workers/stage2"

for required_tool in uv node git; do
  command -v "$required_tool" >/dev/null || abort_preflight missing_tool
done

for required_file in "$manifest_path" "$holdout_path" "$rule_tool_path"; do
  [ -f "$required_file" ] || abort_preflight missing_input
done
if [ "$keywords_path" != "-" ]; then
  [ -f "$keywords_path" ] || abort_preflight missing_input
fi
[ -d "$stage2_model_dir" ] || abort_preflight stage2_model_mismatch
[ -d "$data_dir" ] || abort_preflight missing_input
[ -d "$output_parent" ] || abort_preflight output_parent_missing
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  abort_preflight output_exists
fi

temporary_dir=$(mktemp -d) || abort_preflight temporary_dir_failed
chmod 700 "$temporary_dir" || abort_preflight temporary_dir_failed
mkdir -m 700 "$temporary_dir/logs" "$temporary_dir/models" "$temporary_dir/plan" || abort_preflight temporary_dir_failed
preflight_reason_file="$temporary_dir/plan/preflight-reason"

preflight_reason=manifest_invalid
if ! node -e '
const fs = require("fs");
const [manifestPath, commitPath, reasonPath] = process.argv.slice(1);
try {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      typeof manifest.evaluation_code_commit !== "string" ||
      !/^[0-9a-f]{40,64}$/.test(manifest.evaluation_code_commit)) {
    throw new Error("invalid manifest");
  }
  fs.writeFileSync(commitPath, `${manifest.evaluation_code_commit}\n`, "utf8");
} catch (_error) {
  fs.writeFileSync(reasonPath, "manifest_invalid\n", "utf8");
  process.exit(1);
}
' "$manifest_path" "$temporary_dir/plan/evaluation-code-commit.txt" "$preflight_reason_file" \
  >"$temporary_dir/logs/manifest.log" 2>&1 </dev/null; then
  abort_preflight manifest_invalid
fi

preflight_reason=code_commit_not_ancestor
IFS= read -r evaluation_code_commit <"$temporary_dir/plan/evaluation-code-commit.txt" || abort_preflight manifest_invalid
sealed_commit=$(git -C "$repo_root" rev-parse --verify "${evaluation_code_commit}^{commit}" 2>"$temporary_dir/logs/git.log") \
  || abort_preflight code_commit_not_ancestor
git -C "$repo_root" merge-base --is-ancestor "$sealed_commit" HEAD 2>>"$temporary_dir/logs/git.log" \
  || abort_preflight code_commit_not_ancestor
preflight_reason=evaluation_code_changed
git -C "$repo_root" diff --quiet "$sealed_commit" HEAD -- workers apps/server \
  || abort_preflight evaluation_code_changed
preflight_reason=worktree_dirty
git -C "$repo_root" status --porcelain --untracked-files=all \
  | awk '$0 !~ /^\?\? \.serena\// { print }' >"$temporary_dir/worktree-status.txt"
[ ! -s "$temporary_dir/worktree-status.txt" ] || abort_preflight worktree_dirty

preflight_reason=preflight_validation_failed

set +e
(
  set -e
  cd "$stage1_dir"
  uv run --locked python - \
    "$manifest_path" "$holdout_path" "$rule_tool_path" "$stage2_model_dir" "$data_dir" "$output_dir" \
    "$temporary_dir/plan" "$stage2_dir" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from zg_stage1.data import compute_file_sha256


manifest_path, holdout_path, rule_tool, stage2_model, data_dir, output_dir, plan_dir, stage2_source = map(Path, sys.argv[1:])
reason_path = plan_dir / "preflight-reason"


def fail(reason: str) -> None:
    reason_path.write_text(reason + "\n", encoding="utf-8")
    raise SystemExit(1)


try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError):
    fail("manifest_invalid")
if not isinstance(manifest, dict):
    fail("manifest_invalid")
if compute_file_sha256(holdout_path) != manifest.get("holdout_sha256"):
    fail("holdout_sha256_mismatch")
if compute_file_sha256(rule_tool) != manifest.get("evaluate_rules_sha256"):
    fail("rules_tool_sha256_mismatch")
if output_dir.exists():
    fail("output_exists")
if manifest.get("forward_budget") != 0.304 or manifest.get("short_rule") != {"max_length": 5, "multiplier": 4.0}:
    fail("manifest_invalid")

safe_name = re.compile(r"[A-Za-z0-9._-]+")
stage1 = manifest.get("stage1")
selected = manifest.get("selected")
if not isinstance(stage1, dict) or not isinstance(selected, dict):
    fail("manifest_invalid")
form = selected.get("form")
stage1_root = data_dir / "ml" / "stage1"


def check_stage1(name: object, expected: object) -> None:
    if not isinstance(name, str) or not safe_name.fullmatch(name) or not isinstance(expected, str) or not expected:
        fail("manifest_invalid")
    weight = stage1_root / name / "model.safetensors"
    if not weight.is_file() or compute_file_sha256(weight) != expected:
        fail("weights_sha256_mismatch")


if form == "single":
    units = stage1.get("units")
    if not isinstance(units, list) or len(units) != 3:
        fail("manifest_invalid")
    for unit in units:
        if not isinstance(unit, dict):
            fail("manifest_invalid")
        check_stage1(unit.get("model_dir"), unit.get("weights_sha256"))
elif form == "ensemble":
    names, hashes = stage1.get("model_dirs"), stage1.get("weights_sha256")
    if not isinstance(names, list) or not isinstance(hashes, list) or len(names) != 3 or len(hashes) != 3:
        fail("manifest_invalid")
    for name, expected in zip(names, hashes, strict=True):
        check_stage1(name, expected)
else:
    fail("manifest_invalid")

stage2 = manifest.get("stage2_model")
if not isinstance(stage2, dict) or stage2_model.name != stage2.get("directory_name"):
    fail("stage2_model_mismatch")
files = stage2.get("files")
if not isinstance(files, list) or not files:
    fail("stage2_model_mismatch")
for entry in files:
    if not isinstance(entry, dict):
        fail("stage2_model_mismatch")
    name, expected = entry.get("name"), entry.get("sha256")
    if not isinstance(name, str) or Path(name).name != name or not safe_name.fullmatch(name):
        fail("stage2_model_mismatch")
    path = stage2_model / name
    if not path.is_file() or compute_file_sha256(path) != expected:
        fail("stage2_model_mismatch")

sys.path.insert(0, str(stage2_source))
from zg_stage2.worker import compute_model_identifier  # noqa: E402

if compute_model_identifier(stage2_model) != stage2.get("identifier"):
    fail("stage2_model_mismatch")

(plan_dir / "mix.json").write_text(json.dumps(manifest["traffic_mix"], ensure_ascii=False) + "\n", encoding="utf-8")
short = manifest["short_rule"]
(plan_dir / "common.tsv").write_text(f"{short['max_length']}:{short['multiplier']}\n", encoding="utf-8")


def write_dev(index: int, weights: object, threshold: object) -> None:
    document = {
        "split": "dev",
        "model_weights_sha256": weights,
        "decision": {"mode": "budget", "budget": manifest["forward_budget"], "threshold": threshold},
        "rule_routes": {"policy_sha256": manifest["rule_policy_sha256"]},
        "short_rule": manifest["short_rule"],
        "traffic_mix": manifest["traffic_mix"],
        "stage2_scores": {"model_identifier": stage2["identifier"]},
    }
    (plan_dir / f"dev-{index}.json").write_text(json.dumps(document, ensure_ascii=False) + "\n", encoding="utf-8")


lines = []
if form == "single":
    for index, unit in enumerate(stage1["units"]):
        write_dev(index, unit["weights_sha256"], unit["threshold"])
        lines.append(f"single\t{index}\t{unit['model_dir']}")
else:
    write_dev(0, stage1["weights_sha256"], stage1["threshold"])
    lines.append(f"ensemble\t0\t{','.join(stage1['model_dirs'])}")
(plan_dir / "units.tsv").write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
) >"$temporary_dir/logs/preflight.log" 2>&1 </dev/null
preflight_status=$?
set -e
if [ "$preflight_status" -ne 0 ]; then
  abort_preflight preflight_validation_failed
fi
preflight_reason=

current_stage=rules
rule_arguments=(node "$rule_tool_path" --eval-file "$holdout_path" --output "$temporary_dir/routes.jsonl")
if [ "$keywords_path" != "-" ]; then
  rule_arguments+=(--keywords "$keywords_path")
fi
"${rule_arguments[@]}" >"$temporary_dir/logs/rules.log" 2>&1 </dev/null

current_stage=rules-validation
(
  cd "$stage1_dir"
  uv run --locked python - "$manifest_path" "$holdout_path" "$temporary_dir/routes.jsonl" <<'PY'
import json
import sys
from pathlib import Path

from zg_stage1.chat_eval_data import load_chat_eval_set
from zg_stage1.evaluate_chat import load_rule_routes

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
holdout = Path(sys.argv[2])
_routes, policy = load_rule_routes(Path(sys.argv[3]), load_chat_eval_set(holdout), holdout)
if policy != manifest["rule_policy_sha256"]:
    raise SystemExit(1)
PY
) >"$temporary_dir/logs/rules-validation.log" 2>&1 </dev/null

current_stage=stage2
(
  cd "$stage2_dir"
  uv run --locked python -m zg_stage2.score_eval_set \
    --model-dir "$stage2_model_dir" \
    --eval-file "$holdout_path" \
    --output "$temporary_dir/stage2-scores.json"
) >"$temporary_dir/logs/stage2.log" 2>&1 </dev/null

short_rule=$(sed -n '1p' "$temporary_dir/plan/common.tsv")
report_list="$temporary_dir/report-paths.txt"
: >"$report_list"
while IFS=$'\t' read -r form index model_names; do
  current_stage="stage1-$index"
  report_path="$temporary_dir/holdout-report-$index.json"
  raw_dir="$temporary_dir/raw-$index"
  if [ "$form" = "single" ]; then
    source_model="$data_dir/ml/stage1/$model_names"
    shadow_model="$temporary_dir/models/$model_names"
    mkdir -m 700 "$shadow_model" </dev/null
    for source_file in "$source_model"/*; do
      [ -f "$source_file" ] || continue
      source_name=$(basename -- "$source_file" </dev/null)
      case "$source_name" in
        chat-eval-*.json) continue ;;
      esac
      ln -s "$source_file" "$shadow_model/$source_name" </dev/null
    done
    (
      cd "$stage1_dir"
      uv run --locked python -m zg_stage1.evaluate_chat \
        --model-dir "$shadow_model" \
        --eval-file "$holdout_path" \
        --dev-report "$temporary_dir/plan/dev-$index.json" \
        --mix-file "$temporary_dir/plan/mix.json" \
        --rule-routes "$temporary_dir/routes.jsonl" \
        --short-rule "$short_rule" \
        --stage2-scores "$temporary_dir/stage2-scores.json" \
        --raw-scores-dir "$raw_dir"
    ) >"$temporary_dir/logs/stage1-$index.log" 2>&1 </dev/null
    mv "$shadow_model/chat-eval-holdout.json" "$report_path" </dev/null
  else
    old_ifs=$IFS
    IFS=','
    read -r -a names <<<"$model_names"
    IFS=$old_ifs
    model_arguments=()
    for name in "${names[@]}"; do
      model_arguments+=(--model-dir "$data_dir/ml/stage1/$name")
    done
    (
      cd "$stage1_dir"
      uv run --locked python -m zg_stage1.evaluate_chat \
        "${model_arguments[@]}" \
        --eval-file "$holdout_path" \
        --dev-report "$temporary_dir/plan/dev-$index.json" \
        --mix-file "$temporary_dir/plan/mix.json" \
        --rule-routes "$temporary_dir/routes.jsonl" \
        --short-rule "$short_rule" \
        --stage2-scores "$temporary_dir/stage2-scores.json" \
        --raw-scores-dir "$raw_dir" \
        --output "$report_path"
    ) >"$temporary_dir/logs/stage1-$index.log" 2>&1 </dev/null
  fi
  for raw_path in "$raw_dir"/*.json; do
    raw_name=$(basename -- "$raw_path" </dev/null)
    mv "$raw_path" "$temporary_dir/stage1-unit-$index-$raw_name" </dev/null
  done
  rmdir "$raw_dir" </dev/null
  printf '%s\n' "$report_path" >>"$report_list"
done <"$temporary_dir/plan/units.tsv"

set --
while IFS= read -r report_path; do
  set -- "$@" "$report_path"
done <"$report_list"

current_stage=decision
(
  cd "$stage1_dir"
  uv run --locked python -m zg_stage1.round3_decision holdout \
    --manifest "$manifest_path" \
    --holdout-reports "$@" \
    --output "$temporary_dir/verdict.json"
) >"$temporary_dir/logs/decision.log" 2>&1 </dev/null

current_stage=artifact-hashes
(
  cd "$stage1_dir"
  uv run --locked python - "$temporary_dir" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
verdict_path = root / "verdict.json"
verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
paths = [
    root / "routes.jsonl",
    root / "stage2-scores.json",
    *sorted(root.glob("stage1-unit-*.json")),
    *sorted(root.glob("holdout-report-*.json")),
]
verdict["artifacts"] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
temporary = root / ".verdict.json.tmp"
temporary.write_text(json.dumps(verdict, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.replace(temporary, verdict_path)
PY
) >"$temporary_dir/logs/artifact-hashes.log" 2>&1 </dev/null

current_stage=publish
publish_dir=$(mktemp -d "${output_parent}/.${output_name}.staging.XXXXXX")
chmod 700 "$publish_dir"
cp "$temporary_dir/routes.jsonl" "$temporary_dir/stage2-scores.json" "$publish_dir/"
for artifact in "$temporary_dir"/stage1-unit-*.json "$temporary_dir"/holdout-report-*.json; do
  cp "$artifact" "$publish_dir/"
done
cp -R "$temporary_dir/logs" "$publish_dir/"
cp "$temporary_dir/verdict.json" "$publish_dir/"
if [ -e "$output_dir" ] || [ -L "$output_dir" ]; then
  false
fi
mv "$publish_dir" "$output_dir"
publish_dir=

printf '%s\n' "$output_dir/verdict.json"
