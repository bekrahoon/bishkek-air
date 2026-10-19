with f as (
    select
        f.city_id,
        cast(f.ts_utc + to_hours(c.utc_offset_hours) as date) as date_local,
        f.pm2_5,
        f.us_aqi,
        f.forecast_issued_at
    from {{ ref('stg_air_quality_forecast') }} f
    join {{ ref('cities') }} c using (city_id)
    where f.ts_utc > {{ utc_now() }}
)
select
    city_id,
    date_local,
    round(avg(pm2_5), 1)  as pm25_avg,
    round(max(pm2_5), 1)  as pm25_max,
    round(max(us_aqi), 0) as aqi_max,
    {{ aqi_category('max(us_aqi)') }} as aqi_category,
    max(forecast_issued_at) as forecast_issued_at
from f
group by all
