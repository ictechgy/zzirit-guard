"""워커 HTTP 서버: 유닉스 소켓에서 워커 계약 v1(workers/contract/README.md)을 받는다.

왜 표준 라이브러리인가: 웹 프레임워크 의존성을 늘리지 않기 위해서다(공급망). 대신 표준 서버의 약한 곳을 직접 막는다.
- 연결당 소켓 시간 제한(5초): 느리게 보내는 클라이언트가 처리 스레드를 오래 잡지 못하게 한다.
- 동시 처리 연결 4개: 넘으면 스레드를 만들지 않고 바로 503을 준다.
- 요청마다 연결을 닫는다: keep-alive 연결이 스레드를 붙잡지 않게 한다.
- 기본 오류 페이지(HTML, 요청 일부를 되돌려 씀) 대신 코드만 담은 JSON을 쓴다. 로그에도 요청 내용을 남기지 않는다.
2차 워커(workers/stage2)는 이 파일을 그대로 복사해 쓴다.
"""

from __future__ import annotations

import logging
import os
import socket
import socketserver
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from zg_stage1.worker_contract import (
    MAX_BODY_BYTES,
    ClassifyItem,
    ContractError,
    ItemVerdict,
    build_classify_response,
    build_error_response,
    build_health_response,
    parse_classify_request,
)
from zg_stage1.worker_runtime import SOCKET_FILE_MODE, InferenceBusyError, InferenceRunner

# 연결당 소켓 시간 제한(초). 헤더·본문을 이 안에 다 보내야 한다.
CONNECTION_TIMEOUT_SECONDS = 5.0

# 동시에 처리하는 연결 수 상한. 서버는 단계마다 요청을 하나씩 보내고 상태 확인만 덧붙이므로 넉넉하다.
MAX_CONCURRENT_CONNECTIONS = 4

# 리슨 대기열 길이.
LISTEN_BACKLOG = 16

# 한도를 넘은 연결에 503을 쓸 때 기다리는 최대 시간(초).
BUSY_REPLY_TIMEOUT_SECONDS = 1.0

# 상태 코드별 기본 오류 코드(표준 서버가 요청 줄·헤더를 읽다 실패할 때 쓴다).
ERROR_CODE_BY_STATUS = {
    400: "invalid_request",
    404: "not_found",
    405: "method_not_allowed",
    408: "timeout",
    414: "invalid_request",
    431: "invalid_request",
    501: "method_not_allowed",
}

# 경로별로 받는 메서드.
ALLOWED_METHOD_BY_PATH = {"/classify": "POST", "/health": "GET"}

LOGGER = logging.getLogger("zg_worker")


@dataclass(frozen=True)
class WorkerSettings:
    """처리 스레드가 쓰는 워커 정보. max_items는 한 요청의 항목 수 상한이다."""

    model: str
    max_items: int
    runner: InferenceRunner


def build_busy_reply() -> bytes:
    """스레드를 만들지 않고 바로 쓰는 503 응답(헤더+본문)."""
    body = build_error_response("busy")
    head = f"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    return head.encode("ascii") + body


def reply_busy_and_close(connection: socket.socket) -> None:
    """한도를 넘은 연결에 503을 쓰고 닫는다. 상대가 읽지 않아 쓰기가 막혀도 1초 뒤 포기한다."""
    try:
        connection.settimeout(BUSY_REPLY_TIMEOUT_SECONDS)
        connection.sendall(build_busy_reply())
    except OSError as error:
        LOGGER.info("한도 초과 연결에 503을 보내지 못했습니다(%s). 연결을 닫습니다.", type(error).__name__)
    finally:
        connection.close()


class WorkerHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """유닉스 소켓 HTTP 서버. 소켓 파일은 0600으로 만들고, 동시 처리 연결 수를 제한한다."""

    daemon_threads = True
    block_on_close = False
    request_queue_size = LISTEN_BACKLOG

    def __init__(self, socket_path: Path, settings: WorkerSettings) -> None:
        self.settings = settings
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_CONNECTIONS)
        previous_umask = os.umask(0o177)  # 바인딩 순간부터 0600이 되게 한다(만든 뒤 chmod하면 그 사이가 빈다)
        try:
            super().__init__(str(socket_path), WorkerRequestHandler)
        finally:
            os.umask(previous_umask)
        os.chmod(socket_path, SOCKET_FILE_MODE)

    def process_request(self, request: socket.socket, client_address: object) -> None:  # type: ignore[override]
        """자리가 있으면 처리 스레드를 만들고, 없으면 바로 503을 쓰고 닫는다."""
        if not self._slots.acquire(blocking=False):
            reply_busy_and_close(request)
            return
        try:
            super().process_request(request, client_address)  # type: ignore[arg-type]
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: object) -> None:  # type: ignore[override]
        """처리 스레드 본체. 끝나면 자리를 돌려준다."""
        try:
            super().process_request_thread(request, client_address)  # type: ignore[arg-type]
        finally:
            self._slots.release()


class WorkerRequestHandler(BaseHTTPRequestHandler):
    """연결 하나(요청 하나)를 처리한다. 응답 뒤 연결을 닫는다."""

    protocol_version = "HTTP/1.1"
    timeout = CONNECTION_TIMEOUT_SECONDS
    server: WorkerHTTPServer

    def address_string(self) -> str:
        """유닉스 소켓은 상대 주소가 없다. 표준 서버가 주소를 쓰려다 실패하지 않게 고정값을 준다."""
        return "local"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - 표준 서버의 시그니처를 따른다
        """표준 서버의 접근 로그(요청 줄 포함)를 남기지 않는다. 필요한 로그는 _log_request가 남긴다."""

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """표준 서버의 HTML 오류 페이지 대신 코드만 담은 JSON을 쓴다(요청 일부를 되돌려 쓰지 않는다)."""
        self._reply(code, build_error_response(ERROR_CODE_BY_STATUS.get(code, "invalid_request")))

    def do_POST(self) -> None:  # noqa: N802 - 표준 서버가 부르는 이름
        """POST 요청."""
        self._dispatch("POST")

    def do_GET(self) -> None:  # noqa: N802
        """GET 요청."""
        self._dispatch("GET")

    def do_PUT(self) -> None:  # noqa: N802
        """PUT은 받지 않는다."""
        self._dispatch("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        """DELETE는 받지 않는다."""
        self._dispatch("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        """PATCH는 받지 않는다."""
        self._dispatch("PATCH")

    def _dispatch(self, method: str) -> None:
        """경로·메서드를 확인하고 처리한 뒤, 요청 하나당 로그 한 줄을 남긴다."""
        started = time.monotonic()
        status, body, item_count = self._handle(method)
        self._reply(status, body)
        self._log_request(method, status, item_count, started)

    def _handle(self, method: str) -> tuple[int, bytes, int]:
        """(상태, 본문, 항목 수)를 만든다. 계약 오류는 코드만 담아 돌려준다.

        본문을 읽다 난 소켓 시간 초과는 잡지 않는다. 표준 서버가 응답 없이 연결을 닫는다(느린 클라이언트).
        """
        allowed = ALLOWED_METHOD_BY_PATH.get(self.path)
        if allowed is None:
            return 404, build_error_response("not_found"), 0
        if method != allowed:
            return 405, build_error_response("method_not_allowed"), 0
        if method == "GET":
            return 200, build_health_response(self.server.settings.model), 0
        try:
            items = parse_classify_request(self._read_body(), self.server.settings.max_items)
        except ContractError as error:
            return error.status, build_error_response(error.code), 0
        return self._classify(items)

    def _classify(self, items: list[ClassifyItem]) -> tuple[int, bytes, int]:
        """추론 스레드에 넘겨 응답을 만든다. 늦으면 503, 모델·코드 문제면 500이다."""
        settings = self.server.settings
        try:
            verdicts: list[ItemVerdict] = settings.runner.classify([item.text for item in items])
            return 200, build_classify_response(settings.model, items, verdicts), len(items)
        except InferenceBusyError:
            return 503, build_error_response("busy"), 0
        except Exception as error:  # 모델·코드 문제: 연결은 응답하고 끝내며 로그는 종류만 남긴다
            return handle_unexpected_error(error)

    def _read_body(self) -> bytes:
        """헤더를 확인하고 본문을 정확히 Content-Length만큼 읽는다. 순서: Transfer-Encoding → 길이 → 크기 → 형식."""
        if self.headers.get("Transfer-Encoding") is not None:
            raise ContractError("transfer_encoding")
        length = parse_content_length(self.headers.get("Content-Length"))
        if length > MAX_BODY_BYTES:
            raise ContractError("payload_too_large", 413)
        if not is_json_content_type(self.headers.get("Content-Type")):
            raise ContractError("content_type")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ContractError("invalid_json")
        return body

    def _reply(self, status: int, body: bytes) -> None:
        """응답을 쓰고 연결을 닫게 표시한다."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def _log_request(self, method: str, status: int, item_count: int, started: float) -> None:
        """요청 하나의 로그. 경로·상태·건수·지연만 남긴다(채팅 원문은 남기지 않는다)."""
        latency_milliseconds = (time.monotonic() - started) * 1000
        path = self.path if self.path in ALLOWED_METHOD_BY_PATH else "(unknown)"
        LOGGER.info("%s %s %d items=%d %.1fms", method, path, status, item_count, latency_milliseconds)


def parse_content_length(raw_value: str | None) -> int:
    """Content-Length를 정수로 읽는다. 없으면 411, 숫자가 아니면 400이다."""
    if raw_value is None:
        raise ContractError("length_required", 411)
    if not raw_value.strip().isdigit():
        raise ContractError("invalid_body")
    return int(raw_value.strip())


def is_json_content_type(raw_value: str | None) -> bool:
    """Content-Type이 application/json인지(매개변수는 무시)."""
    return raw_value is not None and raw_value.split(";", 1)[0].strip().lower() == "application/json"


def handle_unexpected_error(error: BaseException) -> tuple[int, bytes, int]:
    """예상하지 못한 추론 오류를 500으로 바꾼다. 메시지에 입력 조각이 있을 수 있어 종류 이름만 남긴다."""
    LOGGER.error("추론 중 예상하지 못한 오류(%s). 모델·입력 처리 코드를 확인하세요.", type(error).__name__)
    return 500, build_error_response("internal"), 0
