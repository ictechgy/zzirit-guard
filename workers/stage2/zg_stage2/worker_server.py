"""워커 HTTP 서버: 유닉스 소켓에서 워커 계약 v1(workers/contract/README.md)을 받는다.

왜 표준 라이브러리인가: 웹 프레임워크 의존성을 늘리지 않기 위해서다(공급망). 대신 표준 서버의 약한 곳을 직접 막는다.
- 요청 마감(5초): 요청 줄·헤더·본문을 연결한 때부터 5초 안에 다 보내야 한다. 한 바이트씩 흘려 보내도 넘지 못한다.
- 동시 처리 연결 4개: 넘으면 스레드를 만들지 않고 바로 503을 준다.
- 요청마다 연결을 닫는다: keep-alive 연결이 스레드를 붙잡지 않게 한다.
- 표준 서버가 직접 내는 오류(501·414·431 등)와 HTML 오류 페이지 대신, 계약의 코드만 담은 JSON을 쓴다. 로그에도 요청 내용을 남기지 않는다.
- 멈출 때는 처리 중인 연결이 끝나기를 기다린다.
2차 워커(workers/stage2)는 이 파일을 그대로 복사해 쓴다(패키지 이름만 다르다).
"""

from __future__ import annotations

import io
import logging
import os
import re
import socket
import socketserver
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from zg_stage2.worker_contract import (
    MAX_BODY_BYTES,
    ClassifyItem,
    ContractError,
    ItemVerdict,
    build_classify_response,
    build_error_response,
    build_health_response,
    parse_classify_request,
)
from zg_stage2.worker_runtime import SOCKET_FILE_MODE, InferenceBusyError, InferenceRunner

# 요청 마감(초): 연결한 때부터 요청 줄·헤더·본문을 다 받을 때까지.
REQUEST_DEADLINE_SECONDS = 5.0

# 응답을 쓸 때의 소켓 시간 제한(초). 상대가 읽지 않아 쓰기가 막혀도 이 뒤에 포기한다.
RESPONSE_WRITE_TIMEOUT_SECONDS = 2.0

# 동시에 처리하는 연결 수 상한. 서버는 단계마다 요청을 하나씩 보내고 상태 확인만 덧붙이므로 넉넉하다.
MAX_CONCURRENT_CONNECTIONS = 4

# 리슨 대기열 길이.
LISTEN_BACKLOG = 16

# 한도를 넘은 연결에 503을 쓸 때 기다리는 최대 시간(초).
BUSY_REPLY_TIMEOUT_SECONDS = 1.0

# Content-Length 값: 앞뒤 ASCII 공백(SP·HTAB)과 ASCII 숫자만 받는다. 비ASCII 공백·위첨자 숫자는 받지 않는다.
CONTENT_LENGTH_PATTERN = re.compile(r"[ \t]*([0-9]+)[ \t]*")

# Content-Length 자릿수 상한. 본문 상한(65,536)보다 큰 값은 정수로 바꾸기 전에 413으로 거절한다.
MAX_CONTENT_LENGTH_DIGITS = 7

# 경로별로 받는 메서드.
ALLOWED_METHOD_BY_PATH = {"/classify": "POST", "/health": "GET"}

LOGGER = logging.getLogger("zg_worker")


@dataclass(frozen=True)
class WorkerSettings:
    """처리 스레드가 쓰는 워커 정보. max_items는 한 요청의 항목 수 상한이다."""

    model: str
    max_items: int
    runner: InferenceRunner


def route_error(path: str, method: str) -> tuple[int, str] | None:
    """경로·메서드가 계약에 없으면 (상태, 오류 코드)를 준다. 경로를 먼저 본다(없는 경로는 메서드와 상관없이 404)."""
    allowed = ALLOWED_METHOD_BY_PATH.get(path)
    if allowed is None:
        return 404, "not_found"
    if method != allowed:
        return 405, "method_not_allowed"
    return None


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


class DeadlineSocketReader(io.RawIOBase):
    """소켓 읽기마다 마감까지 남은 시간만큼만 기다린다. 한 바이트씩 흘려 보내는 클라이언트도 마감 시각을 넘기지 못한다."""

    def __init__(self, connection: socket.socket, deadline: float) -> None:
        super().__init__()
        self._connection = connection
        self._deadline = deadline

    def readable(self) -> bool:
        """읽기 전용 스트림이다."""
        return True

    def readinto(self, buffer: memoryview) -> int:  # type: ignore[override]
        """남은 시간 안에 받은 만큼 채운다. 마감이 지났으면 TimeoutError다(표준 서버가 응답 없이 연결을 닫는다)."""
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request deadline exceeded")
        self._connection.settimeout(remaining)
        return self._connection.recv_into(buffer)


class WorkerHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """유닉스 소켓 HTTP 서버. 소켓 파일은 0600으로 만들고, 동시 처리 연결 수를 제한하며, 멈출 때 처리 스레드를 기다린다."""

    request_queue_size = LISTEN_BACKLOG

    def __init__(self, socket_path: Path, settings: WorkerSettings) -> None:
        self.settings = settings
        self._slots = threading.BoundedSemaphore(MAX_CONCURRENT_CONNECTIONS)
        self._active_lock = threading.Lock()
        self._active_connections = 0
        # 처리 스레드 시작·기록과 닫기를 한 잠금으로 묶는다. 닫는 사이에 막 시작한 스레드를 놓치지 않게 하기 위해서다.
        self._lifecycle_lock = threading.Lock()
        self._closing = False
        self._handler_threads: list[threading.Thread] = []
        previous_umask = os.umask(0o177)  # 바인딩 순간부터 0600이 되게 한다(만든 뒤 chmod하면 그 사이가 빈다)
        try:
            super().__init__(str(socket_path), WorkerRequestHandler)
        finally:
            os.umask(previous_umask)
        os.chmod(socket_path, SOCKET_FILE_MODE)

    def active_connections(self) -> int:
        """지금 처리 중인 연결 수(상태 확인·테스트용)."""
        with self._active_lock:
            return self._active_connections

    def process_request(self, request: socket.socket, client_address: object) -> None:  # type: ignore[override]
        """자리가 있으면 처리 스레드를 만들고, 없으면 바로 503을 쓰고 닫는다."""
        if not self._slots.acquire(blocking=False):
            reply_busy_and_close(request)
            return
        self._change_active(1)
        self._start_handler(request, client_address)

    def _start_handler(self, request: socket.socket, client_address: object) -> None:
        """처리 스레드를 시작하고 기록한다. 닫는 중이면 연결을 닫는다.

        표준 구현은 스레드를 시작하기 전에 기록해, 시작이 실패하면 멈출 때 시작하지 않은 스레드를 기다리다 오류가 난다.
        그래서 시작에 성공한 스레드만, 닫기와 같은 잠금 안에서 기록한다(닫는 사이에 막 시작한 스레드를 놓치지 않게).
        처리 스레드는 데몬이 아니다. 스레드 하나는 요청 마감(5초)·추론 대기(5초)·응답 쓰기(2초)로 끝이 정해져 있다.
        """
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address), name="handler", daemon=False)
        with self._lifecycle_lock:
            if self._closing:
                self._abandon_request(request)
                return
            try:
                thread.start()
            except BaseException:
                self._abandon_request(request)
                raise
            self._handler_threads = [known for known in self._handler_threads if known.is_alive()] + [thread]

    def server_close(self) -> None:
        """새 처리 스레드를 막고, 소켓을 닫은 뒤 처리 중인 요청이 끝나기를 기다린다."""
        with self._lifecycle_lock:
            self._closing = True
            threads = list(self._handler_threads)
        super().server_close()
        for thread in threads:
            thread.join()

    def _abandon_request(self, request: socket.socket) -> None:
        """처리하지 못하는 연결의 자리를 돌려주고 닫는다."""
        self._release_slot()
        self.shutdown_request(request)

    def process_request_thread(self, request: socket.socket, client_address: object) -> None:  # type: ignore[override]
        """처리 스레드 본체. 끝나면 자리를 돌려준다."""
        try:
            super().process_request_thread(request, client_address)  # type: ignore[arg-type]
        finally:
            self._release_slot()

    def handle_error(self, request: object, client_address: object) -> None:
        """처리 중 예외: 표준 서버는 traceback 전체를 찍는다. 예외 종류만 남긴다(요청 내용이 섞이지 않게)."""
        error_type = sys.exc_info()[0]
        LOGGER.error("연결 처리 중 오류(%s). 연결을 닫습니다.", getattr(error_type, "__name__", "unknown"))

    def _release_slot(self) -> None:
        """처리 중 연결 수를 줄이고 자리를 돌려준다."""
        self._change_active(-1)
        self._slots.release()

    def _change_active(self, delta: int) -> None:
        """처리 중 연결 수를 바꾼다."""
        with self._active_lock:
            self._active_connections += delta


class WorkerRequestHandler(BaseHTTPRequestHandler):
    """연결 하나(요청 하나)를 처리한다. 응답 뒤 연결을 닫는다."""

    protocol_version = "HTTP/1.1"
    # 요청 줄을 읽지 못해도 응답에 상태 줄을 쓰게 한다. 표준값(HTTP/0.9)이면 오류 응답에 상태 줄과 헤더가 빠진다.
    default_request_version = "HTTP/1.1"
    request_deadline_seconds = REQUEST_DEADLINE_SECONDS
    server: WorkerHTTPServer

    def parse_request(self) -> bool:
        """요청 줄은 '메서드 경로 HTTP/버전' 세 단어만 받는다. 두 단어(HTTP/0.9)는 400 invalid_request다."""
        if not super().parse_request():
            return False
        if len(self.requestline.split()) != 3:
            self.send_error(400)
            return False
        return True

    def setup(self) -> None:
        """표준 읽기 스트림을 마감이 있는 스트림으로 바꾼다. 원래 스트림은 닫아야 소켓이 제때 닫힌다."""
        super().setup()
        self.rfile.close()
        self.rfile = io.BufferedReader(DeadlineSocketReader(self.connection, time.monotonic() + self.request_deadline_seconds))

    def address_string(self) -> str:
        """유닉스 소켓은 상대 주소가 없다. 표준 서버가 주소를 쓰려다 실패하지 않게 고정값을 준다."""
        return "local"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - 표준 서버의 시그니처를 따른다
        """표준 서버의 접근 로그(요청 줄 포함)를 남기지 않는다. 필요한 로그는 _log_request가 남긴다."""

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        """표준 서버가 직접 내는 오류를 계약의 상태·코드로 바꿔 쓴다.

        모르는 메서드(501)는 경로를 먼저 보고 404나 405로, 요청 줄·헤더 오류(400·414·431·505 등)는 400 invalid_request로 바꾼다.
        """
        path = getattr(self, "path", None)
        mapped = route_error(path, "") if code == 501 and isinstance(path, str) else None
        status, error_code = mapped if mapped is not None else (400, "invalid_request")
        self._reply(status, build_error_response(error_code))

    def do_POST(self) -> None:  # noqa: N802 - 표준 서버가 부르는 이름
        """POST 요청."""
        self._dispatch("POST")

    def do_GET(self) -> None:  # noqa: N802
        """GET 요청."""
        self._dispatch("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        """HEAD는 받지 않는다(본문 없이 405·404만 준다)."""
        self._dispatch("HEAD")

    def do_PUT(self) -> None:  # noqa: N802
        """PUT은 받지 않는다."""
        self._dispatch("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        """DELETE는 받지 않는다."""
        self._dispatch("DELETE")

    def do_PATCH(self) -> None:  # noqa: N802
        """PATCH는 받지 않는다."""
        self._dispatch("PATCH")

    def do_OPTIONS(self) -> None:  # noqa: N802
        """OPTIONS는 받지 않는다."""
        self._dispatch("OPTIONS")

    def _dispatch(self, method: str) -> None:
        """경로·메서드를 확인하고 처리한 뒤, 요청 하나당 로그 한 줄을 남긴다."""
        started = time.monotonic()
        status, body, item_count = self._handle(method)
        self._reply(status, body)
        self._log_request(method, status, item_count, started)

    def _handle(self, method: str) -> tuple[int, bytes, int]:
        """(상태, 본문, 항목 수)를 만든다. 계약 오류는 코드만 담아 돌려준다.

        본문을 읽다 난 마감 초과(TimeoutError)는 잡지 않는다. 표준 서버가 응답 없이 연결을 닫는다(느린 클라이언트).
        """
        rejected = route_error(self.path, method)
        if rejected is not None:
            return rejected[0], build_error_response(rejected[1]), 0
        if method == "GET":
            return 200, build_health_response(self.server.settings.model), 0
        try:
            items = parse_classify_request(self._read_body(), self.server.settings.max_items)
        except ContractError as error:
            return error.status, build_error_response(error.code), 0
        return self._classify(items)

    def _classify(self, items: list[ClassifyItem]) -> tuple[int, bytes, int]:
        """추론 스레드에 넘겨 응답을 만든다. 늦으면 503, 분류기가 입력을 거절하면 그 계약 오류(예: 2차의 text_too_long), 모델·코드 문제면 500이다."""
        settings = self.server.settings
        try:
            verdicts: list[ItemVerdict] = settings.runner.classify([item.text for item in items])
            return 200, build_classify_response(settings.model, items, verdicts), len(items)
        except InferenceBusyError:
            return 503, build_error_response("busy"), 0
        except ContractError as error:
            return error.status, build_error_response(error.code), 0
        except Exception as error:  # 모델·코드 문제: 연결은 응답하고 끝내며 로그는 종류만 남긴다
            return handle_unexpected_error(error)

    def _read_body(self) -> bytes:
        """헤더를 확인하고 본문을 정확히 Content-Length만큼 읽는다. 순서: Transfer-Encoding → 길이 → 크기 → 형식."""
        if self.headers.get("Transfer-Encoding") is not None:
            raise ContractError("transfer_encoding")
        length = parse_content_length(self.headers.get_all("Content-Length") or [])
        if length > MAX_BODY_BYTES:
            raise ContractError("payload_too_large", 413)
        if not is_json_content_type(self.headers.get("Content-Type")):
            raise ContractError("content_type")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ContractError("invalid_json")
        return body

    def _reply(self, status: int, body: bytes) -> None:
        """응답을 쓰고 연결을 닫게 표시한다. HEAD에는 본문을 쓰지 않는다. 상대가 먼저 끊었으면 조용히 끝낸다."""
        self.close_connection = True
        try:
            self.connection.settimeout(RESPONSE_WRITE_TIMEOUT_SECONDS)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if getattr(self, "command", None) != "HEAD":
                self.wfile.write(body)
        except OSError as error:
            LOGGER.info("응답(상태 %d)을 쓰지 못했습니다(%s). 상대가 먼저 끊었습니다.", status, type(error).__name__)

    def _log_request(self, method: str, status: int, item_count: int, started: float) -> None:
        """요청 하나의 로그. 경로·상태·건수·지연만 남긴다(채팅 원문은 남기지 않는다)."""
        latency_milliseconds = (time.monotonic() - started) * 1000
        path = self.path if self.path in ALLOWED_METHOD_BY_PATH else "(unknown)"
        LOGGER.info("%s %s %d items=%d %.1fms", method, path, status, item_count, latency_milliseconds)


def parse_content_length(raw_values: list[str]) -> int:
    """Content-Length를 정수로 읽는다. 없으면 411, 두 번 있거나 ASCII 숫자가 아니면 400, 너무 길면 413이다.

    왜 직접 보나: str.isdigit()은 '²' 같은 글자도 숫자로 보고, 아주 긴 숫자는 정수 변환 한도에 걸린다.
    """
    if not raw_values:
        raise ContractError("length_required", 411)
    if len(raw_values) != 1:
        raise ContractError("invalid_body")
    matched = CONTENT_LENGTH_PATTERN.fullmatch(raw_values[0])
    if matched is None:
        raise ContractError("invalid_body")
    digits = matched.group(1)
    if len(digits) > MAX_CONTENT_LENGTH_DIGITS:
        raise ContractError("payload_too_large", 413)
    return int(digits)


def is_json_content_type(raw_value: str | None) -> bool:
    """Content-Type이 application/json인지(매개변수는 무시)."""
    return raw_value is not None and raw_value.split(";", 1)[0].strip().lower() == "application/json"


def handle_unexpected_error(error: BaseException) -> tuple[int, bytes, int]:
    """예상하지 못한 추론 오류를 500으로 바꾼다. 메시지에 입력 조각이 있을 수 있어 종류 이름만 남긴다."""
    LOGGER.error("추론 중 예상하지 못한 오류(%s). 모델·입력 처리 코드를 확인하세요.", type(error).__name__)
    return 500, build_error_response("internal"), 0
