-- Observed hours only (the upstream "history" endpoint also returns today's
-- forecast hours, which we drop here), enriched with weather and local time.
with aq as (
    select * from {{ ref('stg_air_quality') }}
    where ts_utc <= {{ utc_now() }}
      and pm2_5 is not null
)

select
    aq.city_id,
    c.city_name,
    c.country,
    aq.ts_utc,
    aq.ts_utc + to_hours(c.utc_offset_hours)            as ts_local,
    cast(aq.ts_utc + to_hours(c.utc_offset_hours) as date) as date_local,
    hour(aq.ts_utc + to_hours(c.utc_offset_hours))      as hour_local,
    month(aq.ts_utc + to_hours(c.utc_offset_hours))     as month_local,
    aq.pm2_5,
    aq.pm10,
    aq.no2,
    aq.so2,
    aq.co,
    aq.o3,
    aq.us_aqi,
    {{ aqi_category('aq.us_aqi') }}                     as aqi_category,
    w.temperature_c,
    w.humidity_pct,
    w.wind_kmh,
    w.precipitation_mm,
    w.pressure_hpa
from aq
join {{ ref('cities') }} c using (city_id)
left join {{ ref('stg_weather') }} w
    on w.city_id = aq.city_id and w.ts_utc = aq.ts_utc
