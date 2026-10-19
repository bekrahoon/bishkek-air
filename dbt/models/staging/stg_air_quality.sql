-- One row per city and UTC hour. If a month was re-ingested, keep the latest copy.
select
    city_id,
    ts_utc,
    pm2_5,
    pm10,
    nitrogen_dioxide  as no2,
    sulphur_dioxide   as so2,
    carbon_monoxide   as co,
    ozone             as o3,
    us_aqi,
    _ingested_at
from {{ lake('air_quality') }}
qualify row_number() over (partition by city_id, ts_utc order by _ingested_at desc) = 1
