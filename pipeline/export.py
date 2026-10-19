"""Export dbt marts to compact JSON files consumed by the static dashboard."""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import duckdb

from . import config

log = logging.getLogger(__name__)


def _default(o):
    if isinstance(o, (date, datetime)):
        return o.isoformat()
    if isinstance(o, Decimal):
        return float(o)
    raise TypeError(type(o))


def _rows(con, sql: str) -> list[dict]:
    cur = con.execute(sql)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _write(out_dir: Path, name: str, payload) -> int:
    path = out_dir / f"{name}.json"
    text = json.dumps(payload, default=_default, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text)


def _dbt_results() -> dict:
    path = config.ROOT / "dbt" / "target" / "run_results.json"
    if not path.exists():
        return {}
    res = json.loads(path.read_text())["results"]
    out = {"models": 0, "tests_pass": 0, "tests_warn": 0, "tests_fail": 0}
    for r in res:
        uid = r["unique_id"]
        if uid.startswith("model."):
            out["models"] += r["status"] == "success"
        elif uid.startswith("test."):
            key = {"pass": "tests_pass", "warn": "tests_warn"}.get(r["status"], "tests_fail")
            out[key] += 1
    return out


def run(synthetic: bool = False) -> None:
    out_dir = config.ROOT / "web" / ("demo-data" if synthetic else "data")
    out_dir.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(config.WAREHOUSE_PATH), read_only=True)

    summary = _rows(con, "select * from mart_city_summary order by is_focus desc, pm25_30d desc")

    daily: dict[str, list] = {}
    for r in con.execute(
        "select city_id, date_local, pm25_avg, aqi_max, temp_avg_c from mart_city_daily order by 1, 2"
    ).fetchall():
        daily.setdefault(r[0], []).append([r[1].isoformat(), r[2], r[3], r[4]])

    profile: dict[str, list] = {}
    for r in con.execute(
        "select city_id, month_local, hour_local, pm25_avg from mart_hourly_profile order by 1, 2, 3"
    ).fetchall():
        profile.setdefault(r[0], []).append([r[1], r[2], r[3]])

    effect: dict[str, dict] = {}
    for r in con.execute(
        "select city_id, driver, bin, pm25_avg, n_hours from mart_weather_effect order by 1, 2, 3"
    ).fetchall():
        effect.setdefault(r[0], {}).setdefault(r[1], []).append([r[2], r[3], r[4]])

    seasons = _rows(con, "select city_id, season, pm25_avg, days_over_who, days_observed, worst_day, worst_day_pm25 "
                         "from mart_heating_seasons order by city_id, season_start_year")
    monthly = _rows(con, "select city_id, month, pm25_avg, days_over_who, days_observed from mart_city_monthly "
                         "order by city_id, month")
    forecast = _rows(con, "select city_id, date_local, pm25_avg, pm25_max, aqi_max, aqi_category "
                          "from mart_forecast_daily order by city_id, date_local")

    counts = {
        "hourly_rows": con.execute("select count(*) from fct_air_hourly").fetchone()[0],
        "daily_rows": con.execute("select count(*) from mart_city_daily").fetchone()[0],
        "first_day": con.execute("select min(date_local) from mart_city_daily").fetchone()[0],
        "last_day": con.execute("select max(date_local) from mart_city_daily").fetchone()[0],
    }
    con.close()

    extract_log = config.ROOT / "data" / "last_extract.json"
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "synthetic": synthetic,
        "counts": counts,
        "dbt": _dbt_results(),
        "extract": json.loads(extract_log.read_text()) if extract_log.exists() else None,
        "guidelines": {"who_pm25_24h": 15, "who_pm25_annual": 5},
    }

    sizes = {
        "summary": _write(out_dir, "summary", summary),
        "daily": _write(out_dir, "daily", daily),
        "profile": _write(out_dir, "profile", profile),
        "effect": _write(out_dir, "effect", effect),
        "seasons": _write(out_dir, "seasons", seasons),
        "monthly": _write(out_dir, "monthly", monthly),
        "forecast": _write(out_dir, "forecast", forecast),
    }
    meta["files_bytes"] = sizes
    _write(out_dir, "meta", meta)
    log.info("exported %s to %s", sizes, out_dir)
