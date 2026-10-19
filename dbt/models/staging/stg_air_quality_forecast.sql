select
    city_id,
    ts_utc,
    pm2_5,
    pm10,
    us_aqi,
    _ingested_at as forecast_issued_at
from {{ lake('air_quality_forecast') }}
