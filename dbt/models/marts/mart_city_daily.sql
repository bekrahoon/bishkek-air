-- Daily means per city. Days with fewer than 18 observed hours are excluded
-- so that partial days do not distort averages.
select
    city_id,
    city_name,
    date_local,
    round(avg(pm2_5), 1)          as pm25_avg,
    round(max(pm2_5), 1)          as pm25_max,
    round(avg(pm10), 1)           as pm10_avg,
    round(max(us_aqi), 0)         as aqi_max,
    round(avg(temperature_c), 1)  as temp_avg_c,
    round(min(temperature_c), 1)  as temp_min_c,
    round(avg(wind_kmh), 1)       as wind_avg_kmh,
    count(*)                      as hours_observed,
    count(*) filter (where us_aqi > 150) as hours_unhealthy,
    avg(pm2_5) > {{ var('who_pm25_24h') }} as exceeds_who_pm25
from {{ ref('int_air_hourly') }}
group by all
having count(*) >= 18
