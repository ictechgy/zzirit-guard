# zg-datagen

M2 2차 계획의 학습 후보를 로컬에서 생성하고, 비공개 금칙 목록으로 거른 뒤, 두 라벨러의 독립 판정을 합치는 도구다. 문장 원문은 저장소에 넣지 않으며 CLI 표준 출력에는 집계 JSON만 남긴다.

## 흐름

1. `python -m zg_datagen.generate harmful|twins|boundary ...`로 JSONL과 manifest를 만든다.
2. `python -m zg_datagen.filters ...`로 비공개 목록과 형태 규칙을 적용한다.
3. `python -m zg_datagen.labels make-batches ... --out-dir <묶음> --key-out <비공개 key>`로 작성 의도를 숨긴 라벨 묶음을 만든다. key는 묶음 디렉터리 밖에 둔다(묶음 디렉터리만 외부 라벨러에게 넘긴다).
4. 두 라벨러는 `zg_datagen/label_prompt.md`만 보고 별도 디렉터리에 판정을 작성한다.
5. `python -m zg_datagen.labels merge ...`로 일치한 판정과 집계만 합친다.
6. `python -m zg_datagen.materialize --runs <실행 디렉터리>... --out-harmful H --out-allow A`로 합의한 문장을 원문과 다시 이어 학습 입력(`{id, text}`)을 만든다. 실행 디렉터리마다 `kept-*.jsonl`과 `merged/`를 읽고, id 앞에 실행 이름을 붙인다(여러 실행의 같은 id가 겹치지 않게). 생성 문장끼리 3-gram 자카드 0.7 이상이면 같은 라벨 안에서 먼저 나온 것만 남긴다. 상반 라벨은 의도한 대조쌍일 수 있어 서로 제거하지 않으며, 같은 `parent_id`의 twin끼리도 H1T2/H1T3 변형 수를 보존하려고 비교하지 않는다. 결과는 `zg_stage1.training_mix --generated-harmful/--generated-allow`에 준다.

할당량을 적용할 때는 `--seed N`과 함께 `--harmful-cap N`, 반복 가능한 `--harmful-cap-category CATEGORY=N`, `--twins-per-parent N`을 쓴다. seed는 유해와 허용 순서를 독립적으로 섞어 같은 입력과 설정이 같은 결과를 내게 한다. 범주별 상한을 통과한 유해 id만 twin의 부모로 인정하며 경계 허용과 허용으로 판정된 유해 후보는 twin 상한에 포함하지 않는다. twin 생성에 넘기는 부모 파일의 id는 이미 실행 이름이 붙은 최종 materialize id(`<run name>:<original id>`)여야 하고, 생성된 twin의 `parent_id`도 그 값을 그대로 보존해야 한다. materialize는 `parent_id`에 접두사를 다시 붙이지 않는다.

모든 출력은 새 파일에만 쓰며 권한은 `0600`이다. `sexual.txt`, `minor-markers.txt`, `self-harm-means.txt`에는 한 줄에 한 용어를 두고 주석 줄은 `#`로 시작한다. 이 목록과 생성 결과는 저장소 밖에 보관한다.

실제 모델 실행에는 Python 3.12와 로컬 mlx 변환 모델이 필요하다. 모델 파일 해시는 결과 manifest의 생성기 식별자에 포함된다.
