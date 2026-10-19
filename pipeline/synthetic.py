"""Offline stand-in for the Open-Meteo API, used by tests and CI.

It returns payloads with exactly the same shape as the real API, so the whole
extract -> dbt -> export path runs without network access. The numbers follow
a plausible pattern (winter heating smog, evening peaks, cold = dirtier air)
but are NOT real measurements and are never published.
"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta

from . import config

CITY_BASE = {
    "bishkek": 38, "tokmok": 30, "osh": 28, "jalal_abad": 24,
    "karakol": 14, "naryn": 9, "almaty": 33, "tashkent": 35,
}


def _hours(params: dict) -> list[datetime]:
    if "start_date" in params:
        start = datetime.fromisoformat(params["start_date"])
        end = datetime.fromisoformat(params["end_date"]) + timedelta(days=1)
    else:
        now = datetime.utcnow().replace(minute=0, second=0, microsecond=0)
        start = now.replace(hour=0) - timedelta(days=int(params.get("past_days", 0)))
        end = start + timedelta(days=int(params.get("forecast_days", 5)) + int(params.get("past_days", 0)))
    out, t = [], start
    while t < end:
        out.append(t)
        t += timedelta(hours=1)
    return out


def _city(params: dict) -> str:
    for c in config.load_cities():
        if abs(c.latitude - float(params["latitude"])) < 1e-6:
            return c.city_id
    return "bishkek"


def fake_http_get(url: str, params: dict) -> dict:
    city = _city(params)
    rng = random.Random(f"{city}{params.get('start_date', '')}{url}")
    hours = _hours(params)
    variables = params["hourly"].split(",")
    base = CITY_BASE.get(city, 20)
    data: dict[str, list] = {v: [] for v in variables}
    for t in hours:
        local_h = (t.hour + 6) % 24
        doy = t.timetuple().tm_yday
        winter = (math.cos((doy - 15) / 365 * 2 * math.pi) + 1) / 2  # 1 in mid-Jan
        temp = 12 - 17 * winter + 6 * math.sin((local_h - 9) / 24 * 2 * math.pi) + rng.gauss(0, 2.5)
        evening = math.exp(-((local_h - 21) % 24 - 0) ** 2 / 8) + 0.6 * math.exp(-((local_h - 8) ** 2) / 6)
        wind = max(0.3, rng.gammavariate(2, 1.6) * (1.2 - 0.5 * winter))
        pm25 = max(1.0, base * (0.35 + 2.6 * winter ** 2) * (0.7 + 0.9 * evening) / (0.6 + wind / 4)
                   * math.exp(rng.gauss(0, 0.25)))
        values = {
            "pm2_5": pm25,
            "pm10": pm25 * rng.uniform(1.3, 1.9),
            "nitrogen_dioxide": 8 + 25 * evening * (0.5 + winter) + rng.uniform(0, 6),
            "sulphur_dioxide": 2 + 14 * winter + rng.uniform(0, 3),
            "carbon_monoxide": 180 + 900 * winter * (0.5 + evening) + rng.uniform(0, 80),
            "ozone": max(2.0, 70 - 45 * winter + 20 * math.sin((local_h - 10) / 24 * 2 * math.pi)),
            "us_aqi": min(500, pm25 * 3.1 + 10),
            "temperature_2m": temp,
            "relative_humidity_2m": min(100, max(10, 55 + 20 * winter + rng.gauss(0, 10))),
            "wind_speed_10m": wind,
            "precipitation": max(0.0, rng.gauss(-0.6, 0.6)),
            "surface_pressure": 915 + 8 * winter + rng.gauss(0, 3),
        }
        for v in variables:
            data[v].append(round(values[v], 1))
    return {
        "latitude": params["latitude"],
        "longitude": params["longitude"],
        "hourly": {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in hours], **data},
    }
