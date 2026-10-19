"""Pipeline CLI.

    python -m pipeline.run extract            # pull new/updated data into the lake
    python -m pipeline.run transform          # dbt seed + build (models and tests)
    python -m pipeline.run export             # marts -> web/data/*.json
    python -m pipeline.run all [--synthetic]  # everything, optionally offline
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone

from . import config, export
from .extract import extract_forecast, extract_history, http_get_json

log = logging.getLogger("pipeline")
RUN_LOG = config.ROOT / "data" / "last_extract.json"


def cmd_extract(synthetic: bool) -> None:
    http_get = http_get_json
    if synthetic:
        from .synthetic import fake_http_get
        http_get = fake_http_get
    cities = config.load_cities()
    started = datetime.now(timezone.utc)
    hist = extract_history(cities, http_get=http_get)
    fc = extract_forecast(cities, http_get=http_get)
    summary = {
        "started_at": started.isoformat(timespec="seconds"),
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "synthetic": synthetic,
        "history": hist,
        "forecast": fc,
    }
    RUN_LOG.parent.mkdir(parents=True, exist_ok=True)
    RUN_LOG.write_text(json.dumps(summary, indent=2))
    log.info("extract done: %s", json.dumps({k: v for k, v in hist.items() if k != "errors"}))
    errors = hist["errors"] + fc["errors"]
    if errors and hist["rows"] == 0 and hist["calls"] == 0:
        log.error("every request failed")
        sys.exit(1)


def ensure_lake_ready() -> None:
    """History is required; a missing forecast gets an empty placeholder so the
    dashboard can still be published without it."""
    for source in config.HISTORY_SOURCES:
        if not any((config.LAKE_DIR / source.name).glob("*/*.parquet")):
            log.error("lake has no %s files: run extract first", source.name)
            sys.exit(1)
    fc_dir = config.LAKE_DIR / "air_quality_forecast"
    if not any(fc_dir.glob("*/*.parquet")):
        import pyarrow as pa
        import pyarrow.parquet as pq

        schema = pa.schema(
            [("city_id", pa.string()), ("ts_utc", pa.timestamp("s"))]
            + [(v, pa.float64()) for v in config.AIR_QUALITY.variables]
            + [("_ingested_at", pa.timestamp("s", tz="UTC"))]
        )
        (fc_dir / "city_id=none").mkdir(parents=True, exist_ok=True)
        pq.write_table(schema.empty_table(), fc_dir / "city_id=none" / "latest.parquet")
        log.warning("no forecast available, publishing without it")


def cmd_transform() -> None:
    ensure_lake_ready()
    env =os.environ | {"WAREHOUSE_PATH": str(config.WAREHOUSE_PATH), "LAKE_DIR": str(config.LAKE_DIR)}
    dbt_dir = config.ROOT / "dbt"
    for args in (["seed"], ["build", "--exclude", "resource_type:seed"]):
        subprocess.run(["dbt", *args, "--project-dir", str(dbt_dir), "--profiles-dir", str(dbt_dir)],
                       check=True, env=env)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=["extract", "transform", "export", "all"])
    parser.add_argument("--synthetic", action="store_true", help="use offline fake API (dev/CI only)")
    args = parser.parse_args()

    if args.step in ("extract", "all"):
        cmd_extract(args.synthetic)
    if args.step in ("transform", "all"):
        cmd_transform()
    if args.step in ("export", "all"):
        export.run(synthetic=args.synthetic)


if __name__ == "__main__":
    main()
