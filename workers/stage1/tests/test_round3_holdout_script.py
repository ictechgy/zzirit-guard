"""round3-holdout.sh는 봉인 입력 사전 검사가 실패하면 어떤 결과도 만들지 않는다."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "round3-holdout.sh"


def run_git(repository: Path, *arguments: str) -> str:
    """임시 저장소에서 사용자 전역 설정과 무관하게 git 명령을 실행한다."""
    result = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def sealed_repository(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """커밋 계보 사전 검사만 실제 git으로 검증할 최소 저장소와 가짜 도구를 만든다."""
    repository = tmp_path / "repository"
    script = repository / "workers" / "stage1" / "scripts" / SCRIPT.name
    script.parent.mkdir(parents=True)
    shutil.copyfile(SCRIPT, script)
    script.chmod(0o755)
    (repository / "workers" / "stage2").mkdir(parents=True)
    (repository / "apps" / "server").mkdir(parents=True)
    run_git(repository, "init", "-q")
    run_git(repository, "config", "user.name", "Round3 Test")
    run_git(repository, "config", "user.email", "round3@example.invalid")
    run_git(repository, "add", ".")
    run_git(repository, "commit", "-qm", "evaluation code")
    evaluation_commit = run_git(repository, "rev-parse", "HEAD")

    inputs = tmp_path / "inputs"
    inputs.mkdir()
    holdout = inputs / "holdout.jsonl"
    holdout.write_text('{"id":"h1","text":"sealed-placeholder"}\n', encoding="utf-8")
    rule_tool = inputs / "evaluateRules.js"
    rule_tool.write_text("// placeholder\n", encoding="utf-8")
    stage2_model = inputs / "stage2-model"
    stage2_model.mkdir()
    data_dir = inputs / "data"
    data_dir.mkdir()

    manifest = repository / "docs" / "ml" / "m2-round3-decisions" / "manifest.json"
    manifest.parent.mkdir(parents=True)
    manifest.write_text(json.dumps({"evaluation_code_commit": evaluation_commit}) + "\n", encoding="utf-8")
    run_git(repository, "add", str(manifest.relative_to(repository)))
    run_git(repository, "commit", "-qm", "record sealed manifest")

    tools = tmp_path / "tools"
    tools.mkdir()
    uv = tools / "uv"
    uv.write_text(
        """#!/bin/bash
set -eu
: >"${UV_MARKER:?}"
if [ "${3-}" = python ] && [ "${4-}" = - ] && [ "$#" -ge 12 ]; then
  sed -n 's/.*"evaluation_code_commit"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$5" >"${11}/evaluation-code-commit.txt"
  if [ -n "${PREFLIGHT_FAILURE_REASON-}" ]; then
    printf '%s\n' "$PREFLIGHT_FAILURE_REASON" >"${11}/preflight-reason"
    exit 1
  fi
fi
cat >/dev/null || true
""",
        encoding="utf-8",
    )
    uv.chmod(0o755)
    node = tools / "node"
    node.write_text(
        """#!/bin/bash
set -eu
if [ "${1-}" = -e ]; then
  sed -n 's/.*"evaluation_code_commit"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$3" >"$4"
  if [ ! -s "$4" ]; then
    printf 'manifest_invalid\n' >"$5"
    exit 1
  fi
  exit 0
fi
exit 1
""",
        encoding="utf-8",
    )
    node.chmod(0o755)
    environment = dict(os.environ)
    environment["PATH"] = f"{tools}{os.pathsep}{environment['PATH']}"
    environment["UV_MARKER"] = str(tmp_path / "uv-called")
    arguments = {
        "manifest": str(manifest),
        "holdout": str(holdout),
        "rule_tool": str(rule_tool),
        "stage2_model": str(stage2_model),
        "data_dir": str(data_dir),
        "environment": environment,
    }
    return repository, script, arguments


def run_sealed_script(script: Path, arguments: dict[str, str], output: Path) -> subprocess.CompletedProcess[str]:
    """임시 저장소의 봉인 스크립트를 지정 출력 경로로 실행한다."""
    return subprocess.run(
        [
            str(script),
            arguments["manifest"],
            arguments["holdout"],
            arguments["rule_tool"],
            "-",
            arguments["stage2_model"],
            arguments["data_dir"],
            str(output),
        ],
        env=arguments["environment"],
        capture_output=True,
        text=True,
        check=False,
    )


def install_success_stubs(arguments: dict[str, str]) -> None:
    """봉인 경계·공개 순서만 실행하도록 외부 채점 도구의 최소 산출물을 만든다."""
    tools = Path(arguments["environment"]["PATH"].split(os.pathsep, 1)[0])
    (tools / "node").write_text(
        """#!/bin/bash
set -eu
if [ "${1-}" = -e ]; then
  sed -n 's/.*"evaluation_code_commit"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$3" >"$4"
  if [ ! -s "$4" ]; then
    printf 'manifest_invalid\n' >"$5"
    exit 1
  fi
  exit 0
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then
    printf '{}\n' >"$2"
    exit 0
  fi
  shift
done
exit 1
""",
        encoding="utf-8",
    )
    (tools / "uv").write_text(
        """#!/bin/bash
set -eu
: >"${UV_MARKER:?}"
if [ "${3-}" = python ] && [ "${4-}" = - ] && [ "$#" -ge 12 ]; then
  sed -n 's/.*"evaluation_code_commit"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$5" >"${11}/evaluation-code-commit.txt"
  printf '5:4\n' >"${11}/common.tsv"
  : >"${11}/units.tsv"
fi
output=
previous=
for argument in "$@"; do
  if [ "$previous" = --output ]; then
    output=$argument
    break
  fi
  previous=$argument
done
if [ -n "$output" ]; then
  printf '{}\n' >"$output"
fi
case " $* " in
  *" zg_stage1.round3_decision holdout "*)
    root=$(dirname -- "$output")
    printf '{}\n' >"$root/stage1-unit-0.json"
    printf '{}\n' >"$root/holdout-report-0.json"
    ;;
esac
if [ "$#" -eq 5 ] && [ -n "${CREATE_OUTPUT_DURING_RUN-}" ]; then
  mkdir -p "$CREATE_OUTPUT_DURING_RUN"
fi
cat >/dev/null || true
""",
        encoding="utf-8",
    )


def test_preflight_failure_prints_reason_code_and_writes_nothing(tmp_path: Path) -> None:
    """사전 검사 실패는 내용·경로 대신 짧은 이유 코드만 쓰고 아무 결과도 공개하지 않는다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    arguments["environment"]["PREFLIGHT_FAILURE_REASON"] = "holdout_sha256_mismatch"
    output = tmp_path / "published" / "result"
    output.parent.mkdir()
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "preflight: holdout_sha256_mismatch\n"
    assert not output.exists()


def test_manifest_only_commit_after_evaluation_commit_passes_commit_preflight(tmp_path: Path) -> None:
    """평가 커밋의 후손 HEAD에 결정 manifest만 더해졌으면 사전 검사를 통과한다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    output = tmp_path / "published" / "result"
    output.parent.mkdir()
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "rules\n"
    assert Path(arguments["environment"]["UV_MARKER"]).is_file()
    assert not output.exists()


def test_evaluation_code_change_after_manifest_commit_fails_preflight(tmp_path: Path) -> None:
    """봉인 커밋 뒤 workers 또는 apps/server가 바뀌면 평가 코드 변경으로 거절한다."""
    repository, script, arguments = sealed_repository(tmp_path)
    changed = repository / "workers" / "stage1" / "changed.py"
    changed.write_text("# changed after sealing\n", encoding="utf-8")
    run_git(repository, "add", str(changed.relative_to(repository)))
    run_git(repository, "commit", "-qm", "change evaluation code")
    output = tmp_path / "published" / "result"
    output.parent.mkdir()
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "preflight: evaluation_code_changed\n"
    assert not Path(arguments["environment"]["UV_MARKER"]).exists()
    assert not output.exists()


def test_missing_output_parent_fails_preflight(tmp_path: Path) -> None:
    """출력 부모가 없으면 macOS bash 명령 치환에서도 즉시 이유 코드와 함께 멈춘다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    output = tmp_path / "missing-parent" / "result"
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "preflight: output_parent_missing\n"
    assert not output.exists()


def test_dangling_output_symlink_fails_preflight(tmp_path: Path) -> None:
    """존재하지 않는 대상을 가리키는 출력 symlink도 덮어쓰지 않고 거절한다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    output = tmp_path / "result"
    output.symlink_to(tmp_path / "missing-target", target_is_directory=True)
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "preflight: output_exists\n"
    assert output.is_symlink()


def test_publish_renames_complete_staging_directory_once(tmp_path: Path) -> None:
    """판정과 원시 점수는 출력 부모의 숨은 스테이징에 모인 뒤 완성 디렉터리로 공개된다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    install_success_stubs(arguments)
    output = tmp_path / "published" / "result"
    output.parent.mkdir()
    result = run_sealed_script(script, arguments, output)
    assert result.returncode == 0 and result.stderr == ""
    assert result.stdout == f"{output}/verdict.json\n"
    assert {path.name for path in output.iterdir()} >= {
        "verdict.json",
        "routes.jsonl",
        "stage2-scores.json",
        "stage1-unit-0.json",
        "holdout-report-0.json",
        "logs",
    }
    assert list(output.parent.glob(".result.staging.*")) == []


def test_publish_rejects_output_created_during_scoring(tmp_path: Path) -> None:
    """채점 도중 출력 디렉터리가 생기면 그 안에 스테이징을 옮기지 않고 publish에서 멈춘다."""
    _repository, script, arguments = sealed_repository(tmp_path)
    install_success_stubs(arguments)
    output = tmp_path / "published" / "result"
    output.parent.mkdir()
    arguments["environment"]["CREATE_OUTPUT_DURING_RUN"] = str(output)
    result = run_sealed_script(script, arguments, output)
    assert result.returncode != 0 and result.stderr == "publish\n"
    assert output.is_dir() and not (output / "verdict.json").exists()
    assert list(output.parent.glob(".result.staging.*")) == []


def test_script_contains_sealed_execution_guards_and_raw_artifacts() -> None:
    """셰 판정 스크립트의 권한·신호·원시 점수 공개 계약을 구조로 고정한다."""
    source = SCRIPT.read_text(encoding="utf-8")
    assert "ZG_DATA_DIR" not in source
    assert "for required_tool in uv node git" in source and 'command -v "$required_tool"' in source
    assert "evaluation_code_commit" in source and "merge-base --is-ancestor" in source
    assert 'git -C "$repo_root" diff --quiet' in source and "-- workers apps/server" in source
    assert 'git -C "$repo_root" status --porcelain' in source
    assert source.index("merge-base --is-ancestor") < source.index("from zg_stage1.data import compute_file_sha256")
    assert "evaluate_rules_sha256" in source
    assert "from zg_stage2.worker import compute_model_identifier" in source
    assert "trap 'cleanup; exit 130' INT TERM HUP" in source
    assert "</dev/null" in source
    assert "stage1-unit-*.json" in source and "stage2-scores.json" in source
    assert 'mktemp -d "${output_parent}/.${output_name}.staging.XXXXXX"' in source
    assert 'mv "$publish_dir" "$output_dir"' in source
    assert source.count('[ -e "$output_dir" ] || [ -L "$output_dir" ]') == 2
    assert 'mkdir -m 700 "$output_dir"' not in source
