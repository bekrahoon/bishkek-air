select
    city_id,
    ts_utc,
    temperature_2m        as temperature_c,
    relative_humidity_2m  as humidity_pct,
    wind_speed_10m        as wind_kmh,
    precipitation         as precipitation_mm,
    surface_pressure      as pressure_hpa
from {{ lake('weather') }}
qualify row_number() over (partition by city_id, ts_utc order by _ingested_at desc) = 1
