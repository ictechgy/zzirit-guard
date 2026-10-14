"""워커 테스트 공용 도구: 계약 사례 파일 읽기, 사례 본문 만들기, 유닉스 소켓으로 날 HTTP 요청 보내기.

왜 날 요청인가: Content-Length 없음, chunked, 큰 본문처럼 보통 HTTP 클라이언트가 만들어 주지 않는 요청을 그대로 보내야 해서다.
"""

from __future__ import annotations

import contextlib
import json
import shutil
import socket
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

# 계약 사례 파일(저장소의 workers/contract/v1).
CONTRACT_DIRECTORY = Path(__file__).resolve().parents[2] / "contract" / "v1"

# 응답을 기다리는 최대 시간(초).
RESPONSE_TIMEOUT_SECONDS = 10.0


def load_request_cases() -> list[dict]:
    """요청 사례 목록."""
    return json.loads((CONTRACT_DIRECTORY / "requests.json").read_text(encoding="utf-8"))["cases"]


def build_case_body(case: dict) -> bytes | None:
    """사례의 본문 바이트. 본문이 없는 사례(GET 등)는 None이다."""
    if "raw_body" in case:
        return case["raw_body"].encode("utf-8")
    if "raw_body_hex" in case:
        return bytes.fromhex(case["raw_body_hex"])
    if "generate_raw_bytes" in case:
        return b"x" * case["generate_raw_bytes"]
    if "generate" in case:
        spec = case["generate"]
        text = spec.get("character", "가") * spec["text_length"]
        return json.dumps({"items": [{"id": f"m-{index}", "text": text} for index in range(spec["items"])]}, ensure_ascii=False).encode("utf-8")
    if "body" in case:
        return json.dumps(case["body"], ensure_ascii=False).encode("utf-8")
    return None


def expected_status(case: dict, worker_name: str) -> int:
    """이 워커에서 기대하는 상태 코드."""
    return int(case["status"][worker_name])


def expected_error(case: dict, worker_name: str) -> str:
    """이 워커에서 기대하는 오류 코드. 사례의 error가 워커별 표이면 그 워커의 값을 쓴다."""
    error = case["error"]
    return str(error[worker_name]) if isinstance(error, dict) else str(error)


def build_raw_request(case: dict) -> tuple[bytes, bytes]:
    """사례를 (헤더, 본문) 바이트로 만든다. chunked 사례는 본문을 chunk 형식으로 감싼다."""
    body = build_case_body(case) or b""
    lines = [f"{case.get('method', 'POST')} {case.get('path', '/classify')} HTTP/1.1", "Host: local"]
    if body:
        lines.append(f"Content-Type: {case.get('content_type', 'application/json')}")
    if case.get("transfer_encoding"):
        lines.append(f"Transfer-Encoding: {case['transfer_encoding']}")
        body = f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n"
    elif body and not case.get("omit_content_length"):
        lines.append(f"Content-Length: {len(body)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"), body


@dataclass(frozen=True)
class RawResponse:
    """날 응답의 상태 코드와 JSON 본문."""

    status: int
    body: dict


def parse_raw_response(raw: bytes) -> RawResponse:
    """날 응답 바이트에서 상태 코드와 본문을 꺼낸다."""
    head, _, body = raw.partition(b"\r\n\r\n")
    status = int(head.split(b" ", 2)[1])
    return RawResponse(status, json.loads(body.decode("utf-8")) if body else {})


def receive_all(connection: socket.socket) -> bytes:
    """상대가 연결을 닫을 때까지 읽는다."""
    chunks = []
    while chunk := connection.recv(65536):
        chunks.append(chunk)
    return b"".join(chunks)


def send_raw(socket_path: Path, head: bytes, body: bytes = b"") -> RawResponse:
    """유닉스 소켓으로 요청을 보내고 응답을 읽는다. 서버가 본문을 읽기 전에 응답하고 닫아도(413) 응답을 읽는다."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(RESPONSE_TIMEOUT_SECONDS)
        connection.connect(str(socket_path))
        connection.sendall(head)
        # 413처럼 서버가 본문을 읽지 않고 응답한 뒤 닫으면 본문 쓰기가 끊긴다. 그래도 응답은 아래에서 읽는다.
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            connection.sendall(body)
        return parse_raw_response(receive_all(connection))


def send_case(socket_path: Path, case: dict) -> RawResponse:
    """계약 사례 하나를 보낸다."""
    head, body = build_raw_request(case)
    return send_raw(socket_path, head, body)


def send_json(socket_path: Path, method: str, path: str, document: object | None = None) -> RawResponse:
    """JSON 요청 하나를 보낸다."""
    return send_case(socket_path, {"method": method, "path": path, **({"body": document} if document is not None else {})})


@contextmanager
def short_temporary_directory() -> Iterator[Path]:
    """짧은 임시 디렉터리. pytest의 tmp_path는 macOS 유닉스 소켓 경로 상한(104바이트)을 넘을 수 있어 /tmp 아래에 만든다."""
    path = Path(tempfile.mkdtemp(prefix="zgw-", dir="/tmp"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)
