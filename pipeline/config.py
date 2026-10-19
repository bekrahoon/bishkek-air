"""Central configuration: paths, data sources and the variables we ingest."""
from __future__ import annotations

import csv
import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAKE_DIR = Path(os.environ.get("LAKE_DIR", ROOT / "data" / "lake"))
WAREHOUSE_PATH = Path(os.environ.get("WAREHOUSE_PATH", ROOT / "data" / "warehouse.duckdb"))
WEB_DATA_DIR = ROOT / "web" / "data"
CITIES_SEED = ROOT / "dbt" / "seeds" / "cities.csv"

# First day of history to backfill. CAMS global air-quality history on Open-Meteo
# is reliable from late 2022, so we start at the first full year.
BACKFILL_START = date.fromisoformat(os.environ.get("BACKFILL_START", "2023-01-01"))

# Months of history re-fetched on every incremental run. Upstream models revise
# recent values, so we overwrite the trailing window (idempotent by design).
REFRESH_MONTHS = int(os.environ.get("REFRESH_MONTHS", "2"))

# Wall-clock budget for one extract run. Backfill continues on the next run.
EXTRACT_BUDGET_SECONDS = float(os.environ.get("EXTRACT_BUDGET_SECONDS", "720"))


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    variables: tuple[str, ...]
    extra_params: tuple[tuple[str, str], ...] = ()


AIR_QUALITY = Source(
    name="air_quality",
    url="https://air-quality-api.open-meteo.com/v1/air-quality",
    variables=(
        "pm2_5",
        "pm10",
        "nitrogen_dioxide",
        "sulphur_dioxide",
        "carbon_monoxide",
        "ozone",
        "us_aqi",
    ),
    extra_params=(("domains", "cams_global"),),
)

WEATHER = Source(
    name="weather",
    url="https://historical-forecast-api.open-meteo.com/v1/forecast",
    variables=(
        "temperature_2m",
        "relative_humidity_2m",
        "wind_speed_10m",
        "precipitation",
        "surface_pressure",
    ),
)

HISTORY_SOURCES = (AIR_QUALITY, WEATHER)


@dataclass(frozen=True)
class City:
    city_id: str
    city_name: str
    latitude: float
    longitude: float


def load_cities() -> list[City]:
    with CITIES_SEED.open(newline="", encoding="utf-8") as fh:
        return [
            City(r["city_id"], r["city_name"], float(r["latitude"]), float(r["longitude"]))
            for r in csv.DictReader(fh)
        ]
