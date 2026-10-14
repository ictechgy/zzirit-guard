"""찌리릿 가드 2차 분류기(kanana-safeguard) 워커.

모델은 로컬 디렉터리에서만 읽는다. 허깅페이스 허브를 오프라인으로 두어, 경로를 잘못 주어도 인터넷에서 받지 않게 한다
(mlx_lm.load는 없는 경로를 저장소 이름으로 보고 내려받으려 한다). 허브 설정은 가져올 때 읽히므로 하위 모듈보다 먼저 정한다.
"""

import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
