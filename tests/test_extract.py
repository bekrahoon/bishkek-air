from datetime import date, datetime, timezone

import pyarrow.parquet as pq
import pytest

from pipeline import config, extract
from pipeline.config import City
from pipeline.extract import SourceError, group_contiguous, months_to_fetch, parse_hourly
from pipeline.synthetic import fake_http_get

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
CITY = City("bishkek", "Bishkek", 42.8746, 74.5698)


@pytest.fixture(autouse=True)
def tmp_lake(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "LAKE_DIR", tmp_path / "lake")
    monkeypatch.setattr(config, "BACKFILL_START", date(2025, 9, 1))
    monkeypatch.setattr(config, "REFRESH_MONTHS", 2)
    monkeypatch.setattr(extract.time, "sleep", lambda s: None)
    return tmp_path / "lake"


def test_group_contiguous_splits_gaps_and_caps_length():
    months = [date(2025, m, 1) for m in (1, 2, 3, 5, 6)]
    assert group_contiguous(months) == [
        (date(2025, 1, 1), date(2025, 3, 31)),
        (date(2025, 5, 1), date(2025, 6, 30)),
    ]
    year = [date(2024, m, 1) for m in range(1, 13)] + [date(2025, 1, 1)]
    assert len(group_contiguous(year, max_len=12)) == 2


def test_empty_lake_requests_full_backfill():
    months = months_to_fetch("air_quality", "bishkek", date(2025, 12, 15))
    assert months == [date(2025, m, 1) for m in (9, 10, 11, 12)]


def test_incremental_run_only_refreshes_trailing_window():
    extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2025, 12, 15),
                            http_get=fake_http_get)
    months = months_to_fetch("air_quality", "bishkek", date(2025, 12, 15))
    assert months == [date(2025, 11, 1), date(2025, 12, 1)]


def test_rewrite_is_idempotent():
    for _ in range(2):
        extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2025, 10, 20),
                                http_get=fake_http_get)
    t = pq.read_table(extract.month_path("air_quality", "bishkek", date(2025, 9, 1)))
    assert t.num_rows == 30 * 24
    assert len(set(t.column("ts_utc").to_pylist())) == t.num_rows


def test_parse_rejects_missing_variables():
    payload = {"hourly": {"time": ["2025-01-01T00:00"], "pm2_5": [10.0]}}
    with pytest.raises(SourceError, match="missing"):
        parse_hourly(payload, config.AIR_QUALITY, "bishkek", NOW)


def test_parse_rejects_length_mismatch():
    hourly = {"time": ["2025-01-01T00:00", "2025-01-01T01:00"]}
    hourly |= {v: [1.0] for v in config.AIR_QUALITY.variables}
    with pytest.raises(SourceError, match="length"):
        parse_hourly({"hourly": hourly}, config.AIR_QUALITY, "bishkek", NOW)


def test_api_errors_are_collected_not_fatal():
    def failing(url, params):
        raise SourceError("HTTP 400: date out of range")

    stats = extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2025, 10, 1),
                                    http_get=failing)
    assert stats["rows"] == 0 and len(stats["errors"]) == 1


def test_newest_months_are_fetched_first():
    seen = []

    def recording(url, params):
        seen.append(params["start_date"])
        return fake_http_get(url, params)

    extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2026, 1, 15),
                            http_get=recording)
    assert seen == sorted(seen, reverse=True)


def test_quota_exhaustion_stops_the_run_gracefully():
    calls = []

    def limited(url, params):
        calls.append(params)
        if len(calls) > 1:
            raise extract.RateLimited("daily limit")
        return fake_http_get(url, params)

    stats = extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2026, 1, 15),
                                    http_get=limited)
    assert stats["stopped"].startswith("rate limited")
    assert stats["rows"] > 0 and stats["pending_ranges"] >= 1


def test_time_budget_leaves_work_for_next_run():
    stats = extract.extract_history([CITY], sources=[config.AIR_QUALITY], today=date(2026, 1, 15),
                                    http_get=fake_http_get, budget_seconds=-1)
    assert stats["stopped"] == "time budget" and stats["calls"] == 0
