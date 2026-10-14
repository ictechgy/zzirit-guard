"""worker_server 테스트: 유닉스 소켓 HTTP로 계약 사례 전부, 상태 확인, 바쁨, 동시 처리 한도, 느린 클라이언트, 로그."""

from __future__ import annotations

import contextlib
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
    expected_error,
    expected_status,
    load_request_cases,
    receive_all,
    send_case,
    send_json,
    send_raw,
    short_temporary_directory,
)
from zg_stage1 import worker_server
from zg_stage1.worker_contract import ContractError, ItemVerdict
from zg_stage1.worker_runtime import InferenceRunner
from zg_stage1.worker_server import MAX_CONCURRENT_CONNECTIONS, WorkerHTTPServer, WorkerRequestHandler, WorkerSettings, parse_content_length

# 가짜 모델 식별자.
FAKE_MODEL = "fake@0123456789ab"

# 로그에 나오면 안 되는 채팅 표식.
CHAT_SENTINEL = "채팅표식XYZ"

REQUEST_CASES = load_request_cases()


def length_score(texts: Sequence[str]) -> list[ItemVerdict]:
    """가짜 추론: 문장 길이에 비례한 확률."""
    return [ItemVerdict(min(1.0, len(text) / 1000), None) for text in texts]


@contextmanager
def serving_server(infer: Callable[[Sequence[str]], list], result_wait_seconds: float = 5.0) -> Iterator[tuple[Path, WorkerHTTPServer]]:
    """임시 소켓에 워커 서버를 띄우고 (소켓 경로, 서버)를 준다. 끝나면 서버와 추론 스레드를 멈춘다."""
    with short_temporary_directory() as directory:
        runner = InferenceRunner(lambda: infer, result_wait_seconds=result_wait_seconds)
        runner.start()
        socket_path = directory / "stage1.sock"
        server = WorkerHTTPServer(socket_path, WorkerSettings(FAKE_MODEL, 32, runner))
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield socket_path, server
        finally:
            server.shutdown()
            server.server_close()
            runner.stop()


@contextmanager
def serving(infer: Callable[[Sequence[str]], list], result_wait_seconds: float = 5.0) -> Iterator[Path]:
    """serving_server와 같고 소켓 경로만 준다."""
    with serving_server(infer, result_wait_seconds) as (socket_path, _):
        yield socket_path


def wait_until(condition: Callable[[], bool], seconds: float = 5.0) -> None:
    """조건이 참이 될 때까지 기다린다. 시간 안에 안 되면 실패다(고정 sleep 대신 상태를 보고 기다린다)."""
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "조건을 기다리다 시간이 지났습니다"
        time.sleep(0.01)


@pytest.mark.parametrize("case", REQUEST_CASES, ids=[case["name"] for case in REQUEST_CASES])
def test_contract_request_cases(case: dict) -> None:
    """계약 사례마다 기대한 상태 코드와 오류 코드가 나오고, 성공하면 같은 순서·id로 답한다."""
    with serving(length_score) as socket_path:
        response = send_case(socket_path, case)
    assert response.status == expected_status(case, "stage1")
    if response.status != 200:
        assert response.body == {"error": expected_error(case, "stage1")}
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
        health = send_json(socket_path, "GET", "/health")
        assert health.status == 200 and health.body == {"contract": 1, "model": FAKE_MODEL, "ready": True}
        assert background.is_alive() and not release.is_set()
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
    with serving_server(length_score) as (socket_path, server):
        idle = [open_idle_connection(socket_path) for _ in range(MAX_CONCURRENT_CONNECTIONS)]
        wait_until(lambda: server.active_connections() == MAX_CONCURRENT_CONNECTIONS)
        assert send_json(socket_path, "GET", "/health").body == {"error": "busy"}
        for connection in idle:
            connection.close()
        wait_until(lambda: server.active_connections() == 0)
        assert send_json(socket_path, "GET", "/health").status == 200


def test_slow_client_is_disconnected(monkeypatch: pytest.MonkeyPatch) -> None:
    """요청 줄·헤더를 제시간에 다 보내지 않는 연결은 응답 없이 닫고, 자리를 돌려준다."""
    monkeypatch.setattr(WorkerRequestHandler, "request_deadline_seconds", 0.3)
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


def test_trickling_client_hits_request_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    """한 바이트씩 계속 흘려 보내도(쉬는 틈은 짧아도) 연결한 때부터의 마감을 넘기면 끊긴다."""
    monkeypatch.setattr(WorkerRequestHandler, "request_deadline_seconds", 0.5)
    with serving_server(length_score) as (socket_path, server):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(str(socket_path))
            began = time.monotonic()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                for byte in b"POST /classify HTTP/1.1\r\nX-Slow: " + b"a" * 200:
                    connection.sendall(bytes([byte]))
                    time.sleep(0.02)
            assert time.monotonic() - began < 3.0
        wait_until(lambda: server.active_connections() == 0)


@pytest.mark.parametrize(
    ("request_line", "status", "error"),
    [
        (b"HEAD /health HTTP/1.1", 405, None),
        (b"OPTIONS /classify HTTP/1.1", 405, "method_not_allowed"),
        (b"OPTIONS /missing HTTP/1.1", 404, "not_found"),
        (b"FOO /health HTTP/1.1", 405, "method_not_allowed"),
        (b"FOO /missing HTTP/1.1", 404, "not_found"),
        (b"GET /" + b"a" * 70000 + b" HTTP/1.1", 400, "invalid_request"),
        (b"NOT-HTTP", 400, "invalid_request"),
    ],
)
def test_stdlib_errors_follow_contract(request_line: bytes, status: int, error: str | None) -> None:
    """표준 서버가 직접 내는 응답(모르는 메서드, 긴 요청 줄, 깨진 요청 줄)도 계약의 상태·코드로 나온다. HEAD에는 본문이 없다."""
    with serving(length_score) as socket_path:
        response = send_raw(socket_path, request_line + b"\r\nHost: local\r\n\r\n")
    assert response.status == status
    assert response.body == ({} if error is None else {"error": error})


@pytest.mark.parametrize(
    ("content_length_lines", "status", "error"),
    [
        ([b"Content-Length: \xb2"], 400, "invalid_body"),
        ([b"Content-Length: 1e3"], 400, "invalid_body"),
        ([b"Content-Length: -5"], 400, "invalid_body"),
        ([b"Content-Length: " + b"9" * 4000], 413, "payload_too_large"),
        ([b"Content-Length: 2", b"Content-Length: 2"], 400, "invalid_body"),
    ],
)
def test_content_length_is_parsed_strictly(content_length_lines: list[bytes], status: int, error: str) -> None:
    """Content-Length는 ASCII 숫자 한 번만 받는다. '²'·지수·음수·중복은 400, 너무 긴 숫자는 413이다(트레이스백 없이)."""
    head = b"\r\n".join([b"POST /classify HTTP/1.1", b"Host: local", b"Content-Type: application/json", *content_length_lines]) + b"\r\n\r\n"
    with serving(length_score) as socket_path:
        response = send_raw(socket_path, head, b"{}")
    assert (response.status, response.body) == (status, {"error": error})


def test_client_that_leaves_during_inference_is_cleaned_up(caplog: pytest.LogCaptureFixture) -> None:
    """서버가 2초에 포기하고 끊은 뒤 추론이 끝나도, 트레이스백 없이 정리하고 자리를 돌려준다."""
    caplog.set_level(logging.INFO, logger="zg_worker")
    started, release = threading.Event(), threading.Event()

    def slow(texts: Sequence[str]) -> list[ItemVerdict]:
        started.set()
        release.wait(5)
        return length_score(texts)

    body = json.dumps({"items": [{"id": "a", "text": CHAT_SENTINEL}]}, ensure_ascii=False).encode("utf-8")
    head = f"POST /classify HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\n\r\n".encode()
    with serving_server(slow) as (socket_path, server):
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(str(socket_path))
        connection.sendall(head + body)
        assert started.wait(3)
        connection.close()
        release.set()
        wait_until(lambda: server.active_connections() == 0)
        assert send_json(socket_path, "GET", "/health").status == 200
    assert "Traceback" not in caplog.text and CHAT_SENTINEL not in caplog.text


def test_shutdown_waits_for_active_request() -> None:
    """멈출 때 처리 중인 요청이 끝나기를 기다린다. 그 요청은 정상 응답을 받는다."""
    started, release = threading.Event(), threading.Event()
    responses: list = []

    def slow(texts: Sequence[str]) -> list[ItemVerdict]:
        started.set()
        release.wait(5)
        return length_score(texts)

    with serving_server(slow) as (socket_path, server):
        background = threading.Thread(target=lambda: responses.append(send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})))
        background.start()
        assert started.wait(3)
        server.shutdown()
        closer = threading.Thread(target=server.server_close)
        closer.start()
        time.sleep(0.1)
        assert closer.is_alive()
        release.set()
        closer.join(5)
        background.join(5)
    assert responses and responses[0].status == 200


def test_http_0_9_request_line_is_rejected() -> None:
    """두 단어 요청 줄(HTTP/0.9)은 받지 않는다."""
    with serving(length_score) as socket_path:
        response = send_raw(socket_path, b"GET /health\r\n\r\n")
    assert (response.status, response.body) == (400, {"error": "invalid_request"})


@pytest.mark.parametrize("raw_value", ["\xa02\xa0", "\u20032", "2\u00b2", "+2", ""])
def test_content_length_rejects_non_ascii_whitespace_and_signs(raw_value: str) -> None:
    """Content-Length는 ASCII 공백과 ASCII 숫자만 받는다. 비ASCII 공백은 지우지 않고 거절한다."""
    with pytest.raises(ContractError) as raised:
        parse_content_length([raw_value])
    assert raised.value.code == "invalid_body"


def test_content_length_allows_ascii_whitespace() -> None:
    """앞뒤 ASCII 공백(SP·HTAB)은 받는다."""
    assert parse_content_length([" \t12 "]) == 12


def test_failed_handler_thread_start_does_not_break_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    """처리 스레드를 시작하지 못해도 자리를 돌려주고, 멈출 때 시작하지 않은 스레드를 기다리다 오류가 나지 않는다."""

    class FailingThread(threading.Thread):
        def start(self) -> None:
            raise RuntimeError("can't start new thread")

    with short_temporary_directory() as directory:
        runner = InferenceRunner(lambda: length_score)
        runner.start()
        server = WorkerHTTPServer(directory / "stage1.sock", WorkerSettings(FAKE_MODEL, 32, runner))
        left, right = socket.socketpair()
        monkeypatch.setattr(worker_server.threading, "Thread", FailingThread)
        with pytest.raises(RuntimeError):
            server.process_request(left, None)
        monkeypatch.undo()
        assert server.active_connections() == 0
        server.server_close()
        right.close()
        runner.stop()


def test_classifier_contract_error_is_returned_as_is() -> None:
    """분류기가 입력을 거절하면(예: 2차의 text_too_long) 500이 아니라 그 계약 오류로 답한다."""

    def refusing(texts: Sequence[str]) -> list[ItemVerdict]:
        raise ContractError("text_too_long")

    with serving(refusing) as socket_path:
        response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})
    assert (response.status, response.body) == (400, {"error": "text_too_long"})


def test_invalid_category_is_500() -> None:
    """분류기가 계약 밖의 범주(S8)를 내면 500이다."""
    with serving(lambda texts: [ItemVerdict(0.5, "S8") for _ in texts]) as socket_path:
        response = send_json(socket_path, "POST", "/classify", {"items": [{"id": "a", "text": "가"}]})
    assert (response.status, response.body) == (500, {"error": "internal"})
