"""Extract hourly air-quality and weather data from Open-Meteo into a Parquet lake.

Lake layout (one file per city per month, overwritten on refresh -> idempotent):

    data/lake/<source>/city_id=<city>/month=<YYYY-MM>.parquet
    data/lake/air_quality_forecast/city_id=<city>/latest.parquet
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterable

import pyarrow as pa
import pyarrow.parquet as pq
import requests

from . import config
from .config import City, Source

log = logging.getLogger(__name__)

HttpGet = Callable[[str, dict], dict]


class SourceError(RuntimeError):
    """Raised when the API answers with a client error we should not retry."""


class RateLimited(RuntimeError):
    """The API keeps refusing us (hourly/daily quota): stop extracting for this run."""


def http_get_json(url: str, params: dict, retries: int = 4) -> dict:
    """GET with backoff. One 429 is usually the per-minute window, so we wait it
    out once; repeated 429s mean a longer quota and we give up for this run."""
    delay = 2.0
    limited = 0
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, params=params, timeout=(15, 120))  # big ranges are slow
        except requests.RequestException as exc:  # network blip or slow answer
            if attempt == retries:
                raise SourceError(f"network: {exc}") from exc
            log.warning("network error %s, retry %s/%s", exc, attempt, retries)
        else:
            if resp.status_code == 200:
                return resp.json()
            if resp.status_code == 429:
                limited += 1
                if limited >= 2:
                    raise RateLimited(resp.text[:200])
                log.warning("rate limited, waiting 61 s")
                time.sleep(61)
                continue
            if resp.status_code in (500, 502, 503, 504) and attempt < retries:
                log.warning("HTTP %s from %s, retry %s/%s", resp.status_code, url, attempt, retries)
            else:
                try:
                    reason = resp.json().get("reason", resp.text)
                except ValueError:
                    reason = resp.text
                raise SourceError(f"HTTP {resp.status_code}: {reason[:200]}")
        time.sleep(delay)
        delay *= 2
    raise SourceError("retries exhausted")


# ---------------------------------------------------------------------------
# Month helpers
# ---------------------------------------------------------------------------

def month_start(d: date) -> date:
    return d.replace(day=1)


def next_month(d: date) -> date:
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1)


def iter_months(start: date, end: date) -> Iterable[date]:
    m = month_start(start)
    while m <= end:
        yield m
        m = next_month(m)


def month_key(d: date) -> str:
    return d.strftime("%Y-%m")


def month_path(source: str, city_id: str, month: date) -> Path:
    return config.LAKE_DIR / source / f"city_id={city_id}" / f"month={month_key(month)}.parquet"


def months_to_fetch(source: str, city_id: str, today: date) -> list[date]:
    """Missing months + the trailing refresh window (upstream revises recent data)."""
    refresh_from = month_start(today)
    for _ in range(config.REFRESH_MONTHS - 1):
        refresh_from = month_start(refresh_from - timedelta(days=1))
    return [
        m
        for m in iter_months(config.BACKFILL_START, today)
        if m >= refresh_from or not month_path(source, city_id, m).exists()
    ]


def group_contiguous(months: list[date], max_len: int = 12) -> list[tuple[date, date]]:
    """Collapse months into [first_day, last_day] ranges so we make few API calls."""
    ranges: list[tuple[date, date]] = []
    run: list[date] = []
    for m in months:
        if run and (m != next_month(run[-1]) or len(run) == max_len):
            ranges.append((run[0], next_month(run[-1]) - timedelta(days=1)))
            run = []
        run.append(m)
    if run:
        ranges.append((run[0], next_month(run[-1]) - timedelta(days=1)))
    return ranges


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

@dataclass
class Batch:
    table: pa.Table

    @property
    def rows(self) -> int:
        return self.table.num_rows


def parse_hourly(payload: dict, source: Source, city_id: str, ingested_at: datetime) -> Batch:
    """Turn an Open-Meteo `hourly` block into an Arrow table with a strict schema."""
    hourly = payload.get("hourly")
    if not hourly or "time" not in hourly:
        raise SourceError("response has no hourly block")
    times = hourly["time"]
    missing = [v for v in source.variables if v not in hourly]
    if missing:
        raise SourceError(f"response is missing variables: {missing}")
    for v in source.variables:
        if len(hourly[v]) != len(times):
            raise SourceError(f"length mismatch for {v}")

    columns = {
        "city_id": pa.array([city_id] * len(times), pa.string()),
        "ts_utc": pa.array([datetime.fromisoformat(t) for t in times], pa.timestamp("s")),
    }
    for v in source.variables:
        columns[v] = pa.array(hourly[v], pa.float64())
    columns["_ingested_at"] = pa.array([ingested_at] * len(times), pa.timestamp("s", tz="UTC"))
    return Batch(pa.table(columns))


def write_months(batch: Batch, source_name: str, city_id: str) -> dict[str, int]:
    """Split a batch by calendar month (UTC) and overwrite each month file."""
    written: dict[str, int] = {}
    ts = batch.table.column("ts_utc").to_pylist()
    keys = [t.strftime("%Y-%m") for t in ts]
    for key in sorted(set(keys)):
        mask = pa.array([k == key for k in keys])
        part = batch.table.filter(mask)
        # Drop hours with no measurements at all (e.g. beyond upstream availability).
        value_cols = [c for c in part.column_names if c not in ("city_id", "ts_utc", "_ingested_at")]
        if all(part.column(c).null_count == part.num_rows for c in value_cols):
            continue
        path = month_path(source_name, city_id, date.fromisoformat(key + "-01"))
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        pq.write_table(part, tmp, compression="zstd")
        tmp.replace(path)  # atomic swap
        written[key] = part.num_rows
    return written


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def request_cost(source: Source, start: date, end: date) -> int:
    """Open-Meteo counts a request as several calls: one per 10 variables per 14 days."""
    days = (end - start).days + 1
    return -(-len(source.variables) // 10) * -(-days // 14)


def base_params(city: City, source: Source) -> dict:
    params = {
        "latitude": city.latitude,
        "longitude": city.longitude,
        "hourly": ",".join(source.variables),
        "timezone": "GMT",
    }
    params.update(dict(source.extra_params))
    return params


def extract_history(
    cities: list[City],
    sources: Iterable[Source] = config.HISTORY_SOURCES,
    today: date | None = None,
    http_get: HttpGet = http_get_json,
    budget_seconds: float | None = None,
) -> dict:
    """Fetch missing and stale months, newest first.

    Work is ordered so the most recent quarter of every city lands before any
    older history. A run stops when the time budget is spent or the API quota
    runs out; the next scheduled run continues where this one stopped.
    """
    today = today or datetime.now(timezone.utc).date()
    budget = config.EXTRACT_BUDGET_SECONDS if budget_seconds is None else budget_seconds
    deadline = time.monotonic() + budget
    ingested_at = datetime.now(timezone.utc).replace(microsecond=0)
    stats = {"calls": 0, "rows": 0, "months_written": 0, "pending_ranges": 0,
             "stopped": None, "errors": []}

    tasks = []
    for source in sources:
        for city in cities:
            for start, end in group_contiguous(months_to_fetch(source.name, city.city_id, today), max_len=3):
                tasks.append((end, source, city, start))
    tasks.sort(key=lambda t: (-t[0].toordinal(), t[1].name, t[2].city_id))

    for i, (end, source, city, start) in enumerate(tasks):
        if time.monotonic() > deadline:
            stats["stopped"] = "time budget"
            stats["pending_ranges"] = len(tasks) - i
            break
        end = min(end, today)
        params = base_params(city, source) | {"start_date": start.isoformat(), "end_date": end.isoformat()}
        try:
            payload = http_get(source.url, params)
            stats["calls"] += 1
            batch = parse_hourly(payload, source, city.city_id, ingested_at)
        except RateLimited as exc:
            stats["stopped"] = f"rate limited: {exc}"
            stats["pending_ranges"] = len(tasks) - i
            log.error("API quota exhausted, stopping extract for this run")
            break
        except SourceError as exc:
            msg = f"{source.name}/{city.city_id} {start}..{end}: {exc}"
            log.error(msg)
            stats["errors"].append(msg)
            continue
        written = write_months(batch, source.name, city.city_id)
        stats["rows"] += sum(written.values())
        stats["months_written"] += len(written)
        print(f"[{i + 1}/{len(tasks)}] {source.name}/{city.city_id} {start}..{end} -> "
              f"{sum(written.values())} rows", flush=True)
        time.sleep(request_cost(source, start, end) * 0.15)  # stay well under 600 weighted calls/min
    return stats


def extract_forecast(cities: list[City], http_get: HttpGet = http_get_json, days: int = 5) -> dict:
    """Snapshot the next days of air-quality forecast (overwritten every run)."""
    ingested_at = datetime.now(timezone.utc).replace(microsecond=0)
    stats = {"calls": 0, "rows": 0, "errors": []}
    for city in cities:
        params = base_params(city, config.AIR_QUALITY) | {"forecast_days": days, "past_days": 1}
        try:
            payload = http_get(config.AIR_QUALITY.url, params)
            stats["calls"] += 1
            batch = parse_hourly(payload, config.AIR_QUALITY, city.city_id, ingested_at)
        except (SourceError, RateLimited) as exc:
            stats["errors"].append(f"forecast/{city.city_id}: {exc}")
            continue
        path = config.LAKE_DIR / "air_quality_forecast" / f"city_id={city.city_id}" / "latest.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(batch.table, path, compression="zstd")
        stats["rows"] += batch.rows
    return stats
