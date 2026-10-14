"""worker_server 테스트: 유닉스 소켓 HTTP로 계약 사례 전부, 상태 확인, 바쁨, 동시 처리 한도, 느린 클라이언트, 로그."""

from __future__ import annotations

import json
import logging
import os
import socket
import stat
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import pytest

from tests.worker_cases import (
    build_case_body,
    expected_status,
    load_request_cases,
    receive_all,
    send_case,
    send_json,
    short_temporary_directory,
)
from zg_stage1.worker_contract import ItemVerdict
from zg_stage1.worker_runtime import InferenceRunner
from zg_stage1.worker_server import MAX_CONCURRENT_CONNECTIONS, WorkerHTTPServer, WorkerRequestHandler, WorkerSettings

# 가짜 모델 식별자.
FAKE_MODEL = "fake@0123456789ab"

# 로그에 나오면 안 되는 채팅 표식.
CHAT_SENTINEL = "채팅표식XYZ"

REQUEST_CASES = load_request_cases()


def length_score(texts: Sequence[str]) -> list[ItemVerdict]:
    """가짜 추론: 문장 길이에 비례한 확률."""
    return [ItemVerdict(min(1.0, len(text) / 1000), None) for text in texts]


@contextmanager
def serving(infer: Callable[[Sequence[str]], list], result_wait_seconds: float = 5.0) -> Iterator[Path]:
    """임시 소켓에 워커 서버를 띄우고 소켓 경로를 준다. 끝나면 서버와 추론 스레드를 멈춘다."""
    with short_temporary_directory() as directory:
        runner = InferenceRunner(infer, result_wait_seconds=result_wait_seconds)
        runner.start()
        socket_path = directory / "stage1.sock"
        server = WorkerHTTPServer(socket_path, WorkerSettings(FAKE_MODEL, 32, runner))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield socket_path
        finally:
            server.shutdown()
            server.server_close()
            runner.stop()


@pytest.mark.parametrize("case", REQUEST_CASES, ids=[case["name"] for case in REQUEST_CASES])
def test_contract_request_cases(case: dict) -> None:
    """계약 사례마다 기대한 상태 코드와 오류 코드가 나오고, 성공하면 같은 순서·id로 답한다."""
    with serving(length_score) as socket_path:
        response = send_case(socket_path, case)
    assert response.status == expected_status(case, "stage1")
    if response.status != 200:
        assert response.body == {"error": case["error"]}
        return
    body = build_case_body(case)
    assert body is not None
    request_ids = [item["id"] for item in json.loads(body)["items"]]
    assert [item["id"] for item in response.body["items"]] == request_ids
    assert response.body["contract"] == 1 and response.body["model"] == FAKE_MODEL
    assert all(item["category"] is None and 0 <= item["unsafe_probability"] <= 1 for item in response.body["items"])


def test_socket_file_is_private() -> None:
    """소켓 파일은 0600이다."""
    with serving(length_score) as socket_path:
        assert stat.S_IMODE(os.lstat(socket_path).st_mode) == 0o600


def test_health_answers_while_inference_runs() -> None:
    """추론이 오래 걸려도 상태 확인은 바로 답한다(추론 스레드와 처리 스레드가 나뉘어 있다)."""
    started, release = threading.Event(), threading.Event()

    def slow(texts: Sequence[str]) -> list[ItemVerdict]:
        started.set()
        release.wait(5)
        return length_score(texts)

    with serving(slow) as socket_path:
        background = threading.Thread(target=send_json, args=(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]}))
        background.start()
        assert started.wait(3)
        began = time.monotonic()
        health = send_json(socket_path, "GET", "/health")
        assert health.status == 200 and health.body == {"contract": 1, "model": FAKE_MODEL, "ready": True}
        assert time.monotonic() - began < 1.0
        release.set()
        background.join(5)


def test_busy_when_inference_is_late() -> None:
    """추론이 기다리는 시간을 넘기면 503 busy다."""
    release = threading.Event()

    def stuck(texts: Sequence[str]) -> list[ItemVerdict]:
        release.wait(5)
        return length_score(texts)

    with serving(stuck, result_wait_seconds=0.2) as socket_path:
        response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})
        release.set()
    assert (response.status, response.body) == (503, {"error": "busy"})


def open_idle_connection(socket_path: Path) -> socket.socket:
    """요청을 보내지 않고 붙잡고만 있는 연결."""
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.connect(str(socket_path))
    return connection


def test_connection_limit_replies_busy_without_thread() -> None:
    """동시 처리 연결 한도를 넘은 연결은 바로 503을 받는다. 붙잡던 연결이 닫히면 다시 받는다."""
    with serving(length_score) as socket_path:
        idle = [open_idle_connection(socket_path) for _ in range(MAX_CONCURRENT_CONNECTIONS)]
        time.sleep(0.2)
        assert send_json(socket_path, "GET", "/health").body == {"error": "busy"}
        for connection in idle:
            connection.close()
        deadline = time.monotonic() + 3
        while send_json(socket_path, "GET", "/health").status != 200:
            assert time.monotonic() < deadline
            time.sleep(0.05)


def test_slow_client_is_disconnected(monkeypatch: pytest.MonkeyPatch) -> None:
    """요청 줄·헤더를 제시간에 다 보내지 않는 연결은 응답 없이 닫고, 자리를 돌려준다."""
    monkeypatch.setattr(WorkerRequestHandler, "timeout", 0.3)
    with serving(length_score) as socket_path:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(socket_path))
            connection.sendall(b"POST /classify HTTP/1.1\r\nContent-Length: 10\r\n")
            assert receive_all(connection) == b""
        assert send_json(socket_path, "GET", "/health").status == 200


def test_logs_do_not_contain_chat_text(caplog: pytest.LogCaptureFixture) -> None:
    """성공·실패 요청 모두 로그에 채팅 원문이 남지 않는다. 건수와 상태만 남는다."""
    caplog.set_level(logging.INFO, logger="zg_worker")
    with serving(length_score) as socket_path:
        send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": CHAT_SENTINEL}]})
        send_json(socket_path, "POST", "/classify", {"items": [{"id": "a b", "text": CHAT_SENTINEL}]})
        send_json(socket_path, "POST", f"/{CHAT_SENTINEL}", {"items": []})
    assert CHAT_SENTINEL not in caplog.text
    assert "POST /classify 200 items=1" in caplog.text and "POST /classify 400" in caplog.text


def test_unexpected_inference_error_is_500_without_message(caplog: pytest.LogCaptureFixture) -> None:
    """추론 중 예상하지 못한 오류는 500 internal이고, 로그에는 예외 종류만 남는다(메시지에 입력 조각이 있을 수 있다)."""
    caplog.set_level(logging.INFO, logger="zg_worker")

    def broken(texts: Sequence[str]) -> list[ItemVerdict]:
        raise RuntimeError(texts[0])

    with serving(broken) as socket_path:
        response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": CHAT_SENTINEL}]})
    assert (response.status, response.body) == (500, {"error": "internal"})
    assert "RuntimeError" in caplog.text and CHAT_SENTINEL not in caplog.text


def test_invalid_model_output_is_500() -> None:
    """모델이 계약 밖의 확률(NaN)을 내면 500이다. 서버에 잘못된 값을 보내지 않는다."""
    with serving(lambda texts: [ItemVerdict(float("nan"), None) for _ in texts]) as socket_path:
        response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})
    assert (response.status, response.body) == (500, {"error": "internal"})
