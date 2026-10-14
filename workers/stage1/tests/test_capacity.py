"""capacity 모듈 테스트: 대기열 규칙(가득 참·만료), 분위수, F_max의 단조성과 이론값 근처 여부."""

from __future__ import annotations

import random

import pytest

from zg_stage1.capacity import (
    CapacityScenario,
    Criteria,
    QueuePolicy,
    ServiceTimeModel,
    SimulationResult,
    find_max_forward_fraction,
    generate_arrival_times,
    main,
    percentile,
    simulate_queue,
)
from zg_stage1.errors import MetricError

# 처리 시간을 사실상 고정하는 모델(중앙값 = p95 → σ=0). 손으로 계산한 기대값과 비교하기 위해서다.
FIXED_ONE_SECOND = ServiceTimeModel(median_seconds=1.0, p95_seconds=1.0)


def test_percentile_uses_nearest_rank() -> None:
    """가장 가까운 순위 분위수: 1~100에서 p95는 95, p99는 99, 빈 목록은 0.0이다."""
    values = [float(value) for value in range(1, 101)]
    assert percentile(values, 0.95) == 95.0
    assert percentile(values, 0.99) == 99.0
    assert percentile([], 0.95) == 0.0


def test_service_model_rejects_p95_below_median() -> None:
    """p95가 중앙값보다 작으면 분포가 성립하지 않아 오류를 낸다."""
    with pytest.raises(MetricError, match="p95"):
        ServiceTimeModel(median_seconds=0.2, p95_seconds=0.1).sigma()


def test_service_model_matches_measured_quantiles() -> None:
    """기본 모델에서 뽑은 처리 시간의 중앙값·p95가 스파이크 실측(98ms·131ms)에 가깝다."""
    service = ServiceTimeModel()
    random_generator = random.Random(1)
    samples = [service.sample(random_generator) for _ in range(20000)]
    assert percentile(samples, 0.5) == pytest.approx(0.098, rel=0.02)
    assert percentile(samples, 0.95) == pytest.approx(0.131, rel=0.03)


def test_queue_drops_when_full() -> None:
    """처리 1초, 대기열 2칸에 동시에 4건이 오면: 1건 처리 시작, 2건 대기, 1건은 가득 차서 버린다."""
    result = simulate_queue([0.0, 0.0, 0.0, 0.0], QueuePolicy(capacity=2, max_age_seconds=100.0), FIXED_ONE_SECOND, seed=1)
    assert (result.served, result.dropped_full, result.dropped_expired) == (3, 1, 0)


def test_queue_drops_expired_items_instead_of_serving() -> None:
    """만료 1.5초, 처리 1초에 동시에 3건이 오면 세 번째는 2초 기다리게 되므로 처리하지 않고 버린다."""
    result = simulate_queue([0.0, 0.0, 0.0], QueuePolicy(capacity=10, max_age_seconds=1.5), FIXED_ONE_SECOND, seed=1)
    assert (result.served, result.dropped_expired) == (2, 1)
    assert result.wait_p99_seconds == pytest.approx(1.0)


def test_expired_items_do_not_block_new_arrivals() -> None:
    """만료된 항목이 자리를 차지하고 있어도, 새 항목이 올 때 앞에서부터 버려 자리를 만든다."""
    arrivals = [0.0, 0.0, 0.0, 5.0]
    result = simulate_queue(arrivals, QueuePolicy(capacity=2, max_age_seconds=1.5), ServiceTimeModel(10.0, 10.0), seed=1)
    assert result.dropped_full == 0
    assert result.dropped_expired == 3


def test_arrivals_follow_requested_rate() -> None:
    """포아송 도착 수가 비율 × 시간에 가깝고, 비율 0이면 도착이 없다."""
    arrivals = generate_arrival_times(20.0, 1000.0, random.Random(3))
    assert len(arrivals) == pytest.approx(20000, rel=0.03)
    assert arrivals == sorted(arrivals)
    assert generate_arrival_times(0.0, 10.0, random.Random(3)) == []


def test_drop_rate_is_zero_without_arrivals() -> None:
    """도착이 없으면 버림 비율은 0이다(0으로 나누지 않는다)."""
    assert SimulationResult(0, 0, 0, 0, 0.0, 0.0).drop_rate == 0.0


def small_scenario() -> CapacityScenario:
    """테스트용으로 짧은(10분) 시뮬레이션 조건. 기본 대기열·처리 시간·기준을 쓴다."""
    return CapacityScenario(policy=QueuePolicy(), service=ServiceTimeModel(), criteria=Criteria(), duration_seconds=600.0)


def test_fmax_is_one_when_traffic_is_light() -> None:
    """초당 2건이면 모두 넘겨도 2차가 감당한다."""
    assert find_max_forward_fraction(2.0, small_scenario()) == 1.0


def test_fmax_scales_inversely_with_chat_rate() -> None:
    """2차가 감당하는 도착률은 거의 일정해서, 채팅량이 두 배면 F_max는 약 절반이 된다."""
    scenario = small_scenario()
    at_twenty = find_max_forward_fraction(20.0, scenario)
    at_forty = find_max_forward_fraction(40.0, scenario)
    assert 0.0 < at_forty < at_twenty < 1.0
    assert at_forty == pytest.approx(at_twenty / 2, rel=0.08)


def test_fmax_stays_below_service_capacity() -> None:
    """F_max에서의 2차 도착률은 처리 용량(1/평균 처리 시간 ≈ 초당 10건)보다 작다."""
    scenario = small_scenario()
    stage2_rate = 30.0 * find_max_forward_fraction(30.0, scenario)
    assert stage2_rate < 1 / scenario.service.mean_seconds()
    assert stage2_rate > 0.7 / scenario.service.mean_seconds()


def test_cli_prints_table_and_writes_json(tmp_path, capsys) -> None:
    """CLI는 표를 출력하고 --output이 있으면 JSON을 쓴다."""
    output = tmp_path / "capacity.json"
    main(["--rates", "5", "--duration-seconds", "120", "--output", str(output)])
    assert "| 5 | 1.000 |" in capsys.readouterr().out
    assert '"max_forward_fraction": 1.0' in output.read_text(encoding="utf-8")


def test_reported_fraction_is_feasible_in_every_replication() -> None:
    """Codex가 찾은 반례(초당 20건, 60초, 시드 30): 보고한 F_max는 모든 반복에서 기준을 지켜야 한다."""
    scenario = CapacityScenario(policy=QueuePolicy(), service=ServiceTimeModel(), criteria=Criteria(), duration_seconds=60.0, seed=30)
    fraction = find_max_forward_fraction(20.0, scenario)
    assert 0.0 < fraction < 1.0
    assert scenario.is_feasible(20.0 * fraction)
    assert all(scenario.criteria.is_met_by(result) for result in scenario.simulate_all(20.0 * fraction))


def test_replications_use_different_random_paths() -> None:
    """반복마다 다른 시드를 써서 결과가 다르다(같은 경로만 반복하면 반복의 의미가 없다)."""
    scenario = CapacityScenario(policy=QueuePolicy(), service=ServiceTimeModel(), criteria=Criteria(), duration_seconds=60.0, replications=3)
    results = scenario.simulate_all(9.0)
    assert len(results) == 3
    assert len({result.arrivals for result in results}) > 1
