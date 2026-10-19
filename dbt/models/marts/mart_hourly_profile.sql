-- Typical PM2.5 for each (month, local hour): shows when the air is cleanest.
select
    city_id,
    month_local,
    hour_local,
    round(avg(pm2_5), 1) as pm25_avg,
    count(*)             as n_hours
from {{ ref('int_air_hourly') }}
group by all
