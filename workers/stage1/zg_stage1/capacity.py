"""2차(kanana) 대기열 용량 계산기: 초당 채팅량별로 1차가 2차로 넘겨도 되는 최대 비율(F_max)을 시뮬레이션으로 구한다.

왜 필요한가: 1차 분류기는 '2차 처리 용량 안에서 재현율을 지키는 거름망'이다(docs/ml/2026-10-14-model-strengthening-plan.md).
임계값을 고르려면 먼저 '얼마까지 넘겨도 대기열이 버티는가'를 숫자로 알아야 한다. K-HATERS F1로는 이 값을 알 수 없다.

모델(스펙 §5.4):
- 2차는 한 번에 하나씩 처리한다(직렬). 처리 시간은 로그정규분포로 보고, 스파이크 실측(중앙값 98ms, p95 131ms)에 맞춘다.
- 대기열은 최대 300건이다. 가득 차면 새 항목을 버린다.
- 들어온 지 15초가 지난 항목은 처리하지 않고 버린다(그때쯤이면 채팅이 이미 지나갔다).
- 도착은 포아송 과정으로 본다. 실제 채팅의 몰림(버스트)은 이보다 거칠 수 있어, 결과는 낙관적인 상한이다.
- 우선순위는 무시하고 먼저 온 순서로 처리한다. 버림 비율과 대기 시간 전체를 보는 데는 순서가 영향을 주지 않는다.
- 시드가 다른 반복 여러 번이 모두 기준을 지켜야 통과로 본다. 고른 값은 반올림한 뒤 다시 검증한다.

CLI 사용 예: uv run python -m zg_stage1.capacity --rates 10 20 30 50
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import deque
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from zg_stage1.arguments import fraction_below_one, positive_float, positive_integer
from zg_stage1.errors import MetricError, run_command_line

# 표준정규분포의 95% 분위수. p95와 중앙값으로 로그정규분포의 σ를 구할 때 쓴다.
STANDARD_NORMAL_Q95 = 1.6448536269514722

# 스파이크(kanana-safeguard-8b 4비트 + 접두 캐시)에서 잰 1건 처리 시간.
DEFAULT_SERVICE_MEDIAN_SECONDS = 0.098
DEFAULT_SERVICE_P95_SECONDS = 0.131

# 스펙 §5.4의 대기열 크기와 만료 시간.
DEFAULT_QUEUE_CAPACITY = 300
DEFAULT_MAX_AGE_SECONDS = 15.0

# 통과 기준: 버림 1% 미만, 처리된 항목의 대기 p95 1.5초 이하.
# 왜 1.5초인가: 스펙 §14 성공 기준이 '유해 채팅이 후보로 뜨기까지 p95 2초 이내'다. 나머지 0.5초는 1차 판정·전송 몫으로 남긴다.
DEFAULT_MAX_DROP_RATE = 0.01
DEFAULT_MAX_WAIT_P95_SECONDS = 1.5

# 시뮬레이션 길이(30분)와 시드. 길수록 숫자가 안정되고, 시드를 고정해 같은 결과를 다시 낸다.
DEFAULT_DURATION_SECONDS = 1800.0
DEFAULT_SEED = 20261014

# 독립 반복 횟수. 한 번의 난수 경로만 보면 p95가 기준 근처에서 흔들려, 다른 시드에서는 기준을 넘는 값을 고를 수 있다.
# 그래서 반복 모두에서 기준을 지켜야 '된다'고 본다(보수적인 쪽).
DEFAULT_REPLICATIONS = 5

# 기본으로 계산하는 초당 채팅량. 스펙의 '피크에 초당 수십 건'을 덮는다.
DEFAULT_RATES: tuple[float, ...] = (10.0, 20.0, 30.0, 50.0)

# 이분 탐색 반복 횟수. 2^-14 ≈ 0.00006이라 비율을 소수 셋째 자리까지 믿을 수 있다.
BISECTION_STEPS = 14

# 보고하는 비율의 소수 자릿수. 내림해서, 보고한 값을 그대로 써도 기준을 넘지 않게 한다.
FRACTION_DECIMALS = 3


@dataclass(frozen=True)
class QueuePolicy:
    """2차 대기열 규칙(스펙 §5.4)."""

    capacity: int = DEFAULT_QUEUE_CAPACITY
    max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS


@dataclass(frozen=True)
class ServiceTimeModel:
    """2차 1건 처리 시간의 로그정규분포. 중앙값과 p95로 정한다.

    왜 로그정규인가: 처리 시간은 0보다 크고 오른쪽 꼬리가 길다. 측정값이 중앙값·p95 두 개뿐이라 모수 둘인 분포가 맞다.
    """

    median_seconds: float = DEFAULT_SERVICE_MEDIAN_SECONDS
    p95_seconds: float = DEFAULT_SERVICE_P95_SECONDS

    def sigma(self) -> float:
        """로그 공간의 표준편차. p95가 중앙값보다 작으면 분포가 성립하지 않아 오류를 낸다."""
        if self.p95_seconds < self.median_seconds:
            raise MetricError("처리 시간 p95가 중앙값보다 작습니다. --service-p95-ms가 --service-median-ms 이상인지 확인하세요.")
        return math.log(self.p95_seconds / self.median_seconds) / STANDARD_NORMAL_Q95

    def mean_seconds(self) -> float:
        """평균 처리 시간(로그정규 평균 = 중앙값 × e^(σ²/2)). 이용률을 함께 보여 주는 데 쓴다."""
        return self.median_seconds * math.exp(self.sigma() ** 2 / 2)

    def sample(self, random_generator: random.Random) -> float:
        """처리 시간 하나를 뽑는다."""
        return self.median_seconds * math.exp(random_generator.gauss(0.0, self.sigma()))


@dataclass(frozen=True)
class SimulationResult:
    """한 번의 시뮬레이션 결과. 대기 시간은 처리된 항목만 센다."""

    arrivals: int
    served: int
    dropped_full: int
    dropped_expired: int
    wait_p95_seconds: float
    wait_p99_seconds: float

    @property
    def drop_rate(self) -> float:
        """버린 비율(가득 차서 + 만료돼서). 도착이 없으면 0이다."""
        return (self.dropped_full + self.dropped_expired) / self.arrivals if self.arrivals else 0.0


@dataclass(frozen=True)
class Criteria:
    """F_max를 정하는 통과 기준."""

    max_drop_rate: float = DEFAULT_MAX_DROP_RATE
    max_wait_p95_seconds: float = DEFAULT_MAX_WAIT_P95_SECONDS

    def is_met_by(self, result: SimulationResult) -> bool:
        """결과가 두 기준을 모두 지키는지."""
        return result.drop_rate < self.max_drop_rate and result.wait_p95_seconds <= self.max_wait_p95_seconds


def generate_arrival_times(rate_per_second: float, duration_seconds: float, random_generator: random.Random) -> list[float]:
    """포아송 도착 시각 목록. 도착 간격은 지수분포를 따른다. 비율이 0이면 빈 목록이다."""
    arrival_times: list[float] = []
    if rate_per_second <= 0:
        return arrival_times
    clock = random_generator.expovariate(rate_per_second)
    while clock < duration_seconds:
        arrival_times.append(clock)
        clock += random_generator.expovariate(rate_per_second)
    return arrival_times


def percentile(values: Sequence[float], fraction: float) -> float:
    """정렬해서 고르는 분위수(가장 가까운 순위). 값이 없으면 0.0이다."""
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(fraction * len(ordered)) - 1))]


class SerialQueueSimulator:
    """직렬 처리기 하나와 크기 제한·만료가 있는 FIFO 대기열.

    도착 시각을 순서대로 넣으면, 그 시각 전에 시작할 수 있는 처리를 먼저 진행한 뒤 대기열에 넣는다.
    """

    def __init__(self, policy: QueuePolicy, service: ServiceTimeModel, random_generator: random.Random) -> None:
        self.policy = policy
        self.service = service
        self.random_generator = random_generator
        self.waiting: deque[float] = deque()
        self.server_free_at = 0.0
        self.waits: list[float] = []
        self.dropped_full = 0
        self.dropped_expired = 0

    def start_services_until(self, now: float) -> None:
        """now까지 시작할 수 있는 처리를 차례로 시작한다. 시작 시점에 만료된 항목은 처리하지 않고 버린다."""
        while self.waiting and self.server_free_at <= now:
            arrived_at = self.waiting.popleft()
            started_at = max(self.server_free_at, arrived_at)
            if started_at - arrived_at > self.policy.max_age_seconds:
                self.dropped_expired += 1
                continue
            self.waits.append(started_at - arrived_at)
            self.server_free_at = started_at + self.service.sample(self.random_generator)

    def discard_expired_head(self, now: float) -> None:
        """맨 앞(가장 오래된)부터 만료된 항목을 버린다. 만료 항목이 자리를 차지해 새 항목이 버려지지 않게 하기 위해서다."""
        while self.waiting and now - self.waiting[0] > self.policy.max_age_seconds:
            self.waiting.popleft()
            self.dropped_expired += 1

    def accept(self, arrived_at: float) -> None:
        """한 항목이 도착했다. 처리를 진행하고, 만료 항목을 버리고, 자리가 있으면 넣는다."""
        self.start_services_until(arrived_at)
        self.discard_expired_head(arrived_at)
        if len(self.waiting) >= self.policy.capacity:
            self.dropped_full += 1
            return
        self.waiting.append(arrived_at)
        self.start_services_until(arrived_at)

    def finish(self, arrivals: int) -> SimulationResult:
        """남은 항목을 모두 처리하고 결과를 만든다."""
        self.start_services_until(math.inf)
        return SimulationResult(arrivals, len(self.waits), self.dropped_full, self.dropped_expired, percentile(self.waits, 0.95), percentile(self.waits, 0.99))


def simulate_queue(arrival_times: Sequence[float], policy: QueuePolicy, service: ServiceTimeModel, seed: int) -> SimulationResult:
    """도착 시각 목록을 대기열에 흘려 보내 결과를 낸다. 처리 시간은 seed로 고정한 난수로 뽑는다."""
    simulator = SerialQueueSimulator(policy, service, random.Random(seed))
    for arrived_at in arrival_times:
        simulator.accept(arrived_at)
    return simulator.finish(len(arrival_times))


@dataclass(frozen=True)
class CapacityScenario:
    """F_max 계산 조건. 같은 조건이면 같은 결과가 나오도록 시드를 담는다."""

    policy: QueuePolicy
    service: ServiceTimeModel
    criteria: Criteria
    duration_seconds: float = DEFAULT_DURATION_SECONDS
    seed: int = DEFAULT_SEED
    replications: int = DEFAULT_REPLICATIONS

    def simulate(self, stage2_rate_per_second: float, replication: int = 0) -> SimulationResult:
        """2차 도착률 하나로 반복 한 번을 시뮬레이션한다.

        반복마다 시드를 바꾸되, 같은 반복 번호는 비율이 달라도 같은 시드를 써서 비율끼리 비교가 공정하게 한다.
        """
        replication_seed = self.seed + 2 * replication
        arrival_times = generate_arrival_times(stage2_rate_per_second, self.duration_seconds, random.Random(replication_seed))
        return simulate_queue(arrival_times, self.policy, self.service, replication_seed + 1)

    def simulate_all(self, stage2_rate_per_second: float) -> list[SimulationResult]:
        """모든 반복의 결과."""
        return [self.simulate(stage2_rate_per_second, replication) for replication in range(self.replications)]

    def is_feasible(self, stage2_rate_per_second: float) -> bool:
        """모든 반복에서 기준을 지키는지."""
        return all(self.criteria.is_met_by(result) for result in self.simulate_all(stage2_rate_per_second))


def bisect_feasible_fraction(chat_rate_per_second: float, scenario: CapacityScenario) -> float:
    """기준을 지키는 전달 비율의 경계를 이분 탐색으로 좁힌다. 아래쪽(통과한 쪽) 끝을 돌려준다."""
    lower, upper = 0.0, 1.0
    for _step in range(BISECTION_STEPS):
        middle = (lower + upper) / 2
        if scenario.is_feasible(chat_rate_per_second * middle):
            lower = middle
        else:
            upper = middle
    return lower


def find_max_forward_fraction(chat_rate_per_second: float, scenario: CapacityScenario) -> float:
    """초당 채팅량에서 기준을 지키는 최대 2차 전달 비율(F_max). 0~1, 소수 셋째 자리.

    왜 마지막에 다시 확인하나: 유한한 시뮬레이션의 p95는 비율에 대해 완전히 단조롭지 않다. 이분 탐색 결과를 내림한
    값도 기준을 넘을 수 있어, 보고할 값 자체가 통과할 때까지 0.001씩 내린다.
    """
    if scenario.is_feasible(chat_rate_per_second):
        return 1.0
    step = 10**-FRACTION_DECIMALS
    fraction = math.floor(bisect_feasible_fraction(chat_rate_per_second, scenario) / step) * step
    while fraction > 0 and not scenario.is_feasible(chat_rate_per_second * fraction):
        fraction = max(0.0, fraction - step)
    return round(fraction, FRACTION_DECIMALS)


@dataclass(frozen=True)
class CapacityRow:
    """초당 채팅량 하나의 결과 행."""

    chat_rate_per_second: float
    max_forward_fraction: float
    stage2_rate_per_second: float
    utilization: float
    drop_rate: float
    wait_p95_seconds: float
    wait_p99_seconds: float


def build_capacity_row(chat_rate_per_second: float, scenario: CapacityScenario) -> CapacityRow:
    """F_max를 찾고, 그 비율에서의 2차 도착률·이용률과 반복 중 가장 나쁜 버림·대기 p95·p99를 기록한다."""
    fraction = find_max_forward_fraction(chat_rate_per_second, scenario)
    stage2_rate = chat_rate_per_second * fraction
    results = scenario.simulate_all(stage2_rate)
    utilization = stage2_rate * scenario.service.mean_seconds()
    return CapacityRow(
        chat_rate_per_second,
        fraction,
        round(stage2_rate, 3),
        round(utilization, 3),
        round(max(result.drop_rate for result in results), 4),
        round(max(result.wait_p95_seconds for result in results), 3),
        round(max(result.wait_p99_seconds for result in results), 3),
    )


def build_argument_parser() -> argparse.ArgumentParser:
    """CLI 인자. 모든 기본값은 스펙 §5.4와 스파이크 실측이다."""
    parser = argparse.ArgumentParser(prog="python -m zg_stage1.capacity", description="2차 대기열이 감당하는 최대 1차 전달 비율(F_max)")
    parser.add_argument("--rates", type=positive_float, nargs="+", default=list(DEFAULT_RATES), help="초당 채팅량(여러 개)")
    parser.add_argument("--service-median-ms", type=positive_float, default=DEFAULT_SERVICE_MEDIAN_SECONDS * 1000, help="2차 1건 처리 시간 중앙값(ms)")
    parser.add_argument("--service-p95-ms", type=positive_float, default=DEFAULT_SERVICE_P95_SECONDS * 1000, help="2차 1건 처리 시간 p95(ms)")
    parser.add_argument("--queue-capacity", type=positive_integer, default=DEFAULT_QUEUE_CAPACITY, help="대기열 크기")
    parser.add_argument("--max-age-seconds", type=positive_float, default=DEFAULT_MAX_AGE_SECONDS, help="대기 만료 시간(초)")
    parser.add_argument("--max-drop-rate", type=fraction_below_one, default=DEFAULT_MAX_DROP_RATE, help="허용 버림 비율")
    parser.add_argument("--max-wait-p95-seconds", type=positive_float, default=DEFAULT_MAX_WAIT_P95_SECONDS, help="허용 대기 p95(초)")
    parser.add_argument("--duration-seconds", type=positive_float, default=DEFAULT_DURATION_SECONDS, help="시뮬레이션 길이(초)")
    parser.add_argument("--seed", type=positive_integer, default=DEFAULT_SEED, help="난수 시드")
    parser.add_argument("--replications", type=positive_integer, default=DEFAULT_REPLICATIONS, help="독립 반복 횟수(모두 기준을 지켜야 통과)")
    parser.add_argument("--output", type=Path, help="결과 JSON을 쓸 경로(없으면 표만 출력)")
    return parser


def build_scenario(arguments: argparse.Namespace) -> CapacityScenario:
    """인자로 시뮬레이션 조건을 만든다."""
    return CapacityScenario(
        policy=QueuePolicy(arguments.queue_capacity, arguments.max_age_seconds),
        service=ServiceTimeModel(arguments.service_median_ms / 1000, arguments.service_p95_ms / 1000),
        criteria=Criteria(arguments.max_drop_rate, arguments.max_wait_p95_seconds),
        duration_seconds=arguments.duration_seconds,
        seed=arguments.seed,
        replications=arguments.replications,
    )


def format_rows_markdown(rows: Sequence[CapacityRow]) -> str:
    """결과 행을 Markdown 표로 만든다."""
    lines = ["| 초당 채팅 | F_max | 2차 도착/s | 이용률 | 버림 | 대기 p95(s) | 대기 p99(s) |", "|---|---|---|---|---|---|---|"]
    for row in rows:
        lines.append(
            f"| {row.chat_rate_per_second:g} | {row.max_forward_fraction:.3f} | {row.stage2_rate_per_second:.2f} | "
            f"{row.utilization:.2f} | {row.drop_rate:.4f} | {row.wait_p95_seconds:.2f} | {row.wait_p99_seconds:.2f} |"
        )
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> None:
    """초당 채팅량마다 F_max를 계산해 표로 출력하고, --output이 있으면 JSON으로도 쓴다."""
    arguments = build_argument_parser().parse_args(argv)
    scenario = build_scenario(arguments)
    rows = [build_capacity_row(rate, scenario) for rate in arguments.rates]
    print(format_rows_markdown(rows))
    if arguments.output is not None:
        payload = {"scenario": asdict(scenario), "rows": [asdict(row) for row in rows]}
        arguments.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n저장: {arguments.output.name}")


if __name__ == "__main__":
    run_command_line(main)
