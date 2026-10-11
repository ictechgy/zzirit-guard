"""results/*.summary.json과 *.rows.jsonl을 모아 비교표와 채팅 샘플별 판정표를 출력한다."""

import json
import sys
from pathlib import Path

# 채팅 샘플 판정표에서 문장을 자를 길이(터미널 가독성용).
TEXT_PREVIEW_LENGTH = 28


def load_summaries(results_dir: Path) -> list[dict]:
    """요약 파일을 실행 이름순으로 읽는다."""
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(results_dir.glob("*.summary.json"))]


def print_performance_table(summaries: list[dict]) -> None:
    """메모리·지연·처리량 비교표를 마크다운으로 출력한다."""
    print("| 실행 | 적재 후 메모리 | 최대 메모리 | 채팅 중앙값 | 채팅 p95 | 직렬 처리량(채팅) | 긴 댓글 중앙값 |")
    print("|---|---|---|---|---|---|---|")
    for summary in summaries:
        chat_latency, khaters_latency = summary["latency_chat"], summary["latency_khaters"]
        print(
            f"| {summary['run_label']} | {summary['memory_after_load_gb']}GB | {summary['peak_memory_gb']}GB"
            f" | {chat_latency['median_ms']}ms | {chat_latency['p95_ms']}ms"
            f" | {chat_latency['serial_messages_per_second']}건/s | {khaters_latency['median_ms']}ms |"
        )


def print_quality_table(summaries: list[dict]) -> None:
    """채팅셋·K-HATERS 이진 지표와 그룹별 표시 비율을 출력한다."""
    print("\n| 실행 | 기준 | 채팅 P/R/F1 | 채팅 그룹별 표시 | K-HATERS P/R/F1 | K-HATERS 라벨별 표시 |")
    print("|---|---|---|---|---|---|")
    for summary in summaries:
        for mode, quality in summary["quality"].items():
            chat, khaters = quality["chat"], quality["khaters"]
            print(
                f"| {summary['run_label']} | {mode} | {chat['precision']}/{chat['recall']}/{chat['f1']}"
                f" | {format_groups(chat['flag_rate_by_group'])} | {khaters['precision']}/{khaters['recall']}/{khaters['f1']}"
                f" | {format_groups(khaters['flag_rate_by_group'])} |"
            )


def format_groups(flag_rates: dict) -> str:
    """그룹별 표시 비율을 한 줄 문자열로 만든다."""
    return ", ".join(f"{group} {rate}" for group, rate in flag_rates.items())


def print_chat_verdicts(results_dir: Path) -> None:
    """채팅 샘플마다 모델별 판정을 한 줄로 나란히 보여 준다(오판 패턴 확인용)."""
    rows_by_run = {
        path.name.removesuffix(".rows.jsonl"): [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        for path in sorted(results_dir.glob("*.rows.jsonl"))
    }
    run_labels = list(rows_by_run)
    print("\n| id | 그룹 | 기대 | 문장 | " + " | ".join(run_labels) + " |")
    print("|---" * (4 + len(run_labels)) + "|")
    chat_rows_by_run = {label: [row for row in rows if row["source"] == "chat"] for label, rows in rows_by_run.items()}
    for index, base_row in enumerate(chat_rows_by_run[run_labels[0]]):
        verdict_cells = [format_verdict(chat_rows_by_run[label][index]) for label in run_labels]
        preview = base_row["text"].replace("\n", "⏎")[:TEXT_PREVIEW_LENGTH]
        print(f"| {base_row['sample_id']} | {base_row['group']} | {base_row['expected']} | {preview} | " + " | ".join(verdict_cells) + " |")


def format_verdict(row: dict) -> str:
    """판정 1건을 '라벨(유해확률)' 형태로 줄인다."""
    label = row["label"].replace("<", "").replace(">", "")
    probability = row["unsafe_probability"]
    probability_text = f"({probability:.2f})" if probability is not None else ""
    return f"{label}{probability_text}"


def main() -> None:
    """인자로 받은 results 디렉터리의 결과를 출력한다."""
    results_dir = Path(sys.argv[1])
    summaries = load_summaries(results_dir)
    print_performance_table(summaries)
    print_quality_table(summaries)
    print_chat_verdicts(results_dir)


if __name__ == "__main__":
    main()
