"""공용 워커 모듈 복사본 테스트: 2차의 계약·런타임·서버와 테스트 도구가 1차 원본과 패키지 이름 말고는 같아야 한다.

왜: 두 워커는 의존성이 달라(PyTorch·mlx) 패키지로 나누지 않고 복사해 쓴다. 한쪽만 고치면 계약이 어긋나므로 여기서 잡는다.
고칠 때는 1차(workers/stage1/zg_stage1)를 고친 뒤 이 디렉터리로 다시 복사한다.
"""

from __future__ import annotations

from pathlib import Path

import pytest

STAGE2_ROOT = Path(__file__).resolve().parents[1]
STAGE1_ROOT = STAGE2_ROOT.parent / "stage1"
SHARED_FILES = ["zg_{}/worker_contract.py", "zg_{}/worker_runtime.py", "zg_{}/worker_server.py"]


@pytest.mark.parametrize("pattern", SHARED_FILES)
def test_shared_module_matches_stage1(pattern: str) -> None:
    """공용 모듈은 패키지 이름만 다르다."""
    original = (STAGE1_ROOT / pattern.format("stage1")).read_text(encoding="utf-8")
    copy = (STAGE2_ROOT / pattern.format("stage2")).read_text(encoding="utf-8")
    assert copy == original.replace("zg_stage1", "zg_stage2"), f"{pattern.format('stage2')}를 1차 원본에서 다시 복사하세요"


def test_test_helpers_match_stage1() -> None:
    """계약 사례를 보내는 테스트 도구도 같다."""
    original = (STAGE1_ROOT / "tests" / "worker_cases.py").read_text(encoding="utf-8")
    copy = (STAGE2_ROOT / "tests" / "worker_cases.py").read_text(encoding="utf-8")
    assert copy == original.replace("zg_stage1", "zg_stage2")
