"""2차 워커 HTTP 테스트: 계약 사례 전부를 2차 기준(항목 4건까지, 범주 S1~S7)으로 보낸다. 공용 서버의 나머지 동작은 1차 테스트가 맡는다."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import pytest

from tests.worker_cases import build_case_body, expected_status, load_request_cases, send_case, short_temporary_directory
from zg_stage2.worker import MAX_ITEMS_PER_REQUEST
from zg_stage2.worker_contract import ItemVerdict
from zg_stage2.worker_runtime import InferenceRunner
from zg_stage2.worker_server import WorkerHTTPServer, WorkerSettings

FAKE_MODEL = "kanana-fake@0123456789ab"
REQUEST_CASES = load_request_cases()


def fake_kanana(texts: Sequence[str]) -> list[ItemVerdict]:
    """가짜 판정: 문장 길이로 확률을 정하고 범주는 S2."""
    return [ItemVerdict(min(1.0, len(text) / 100), "S2") for text in texts]


@contextmanager
def serving() -> Iterator[Path]:
    """임시 소켓에 2차 워커 서버를 띄운다."""
    with short_temporary_directory() as directory:
        runner = InferenceRunner(lambda: fake_kanana)
        runner.start()
        socket_path = directory / "stage2.sock"
        server = WorkerHTTPServer(socket_path, WorkerSettings(FAKE_MODEL, MAX_ITEMS_PER_REQUEST, runner))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield socket_path
        finally:
            server.shutdown()
            server.server_close()
            runner.stop()


@pytest.mark.parametrize("case", REQUEST_CASES, ids=[case["name"] for case in REQUEST_CASES])
def test_contract_request_cases_for_stage2(case: dict) -> None:
    """계약 사례마다 2차 기준 상태 코드가 나오고, 성공하면 같은 순서·id와 S1~S7 범주로 답한다."""
    with serving() as socket_path:
        response = send_case(socket_path, case)
    assert response.status == expected_status(case, "stage2")
    if response.status != 200:
        assert response.body == {"error": case["error"]}
        return
    body = build_case_body(case)
    assert body is not None
    assert [item["id"] for item in response.body["items"]] == [item["id"] for item in json.loads(body)["items"]]
    assert all(item["category"] == "S2" for item in response.body["items"])
