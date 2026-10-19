-- How PM2.5 depends on temperature (heating) and wind (dispersion).
with binned as (
    select
        city_id,
        pm2_5,
        floor(temperature_c / 5) * 5                as temp_bin_c,
        least(floor(wind_kmh / 3) * 3, 24)          as wind_bin_kmh
    from {{ ref('int_air_hourly') }}
    where temperature_c is not null and wind_kmh is not null
)
select 'temperature' as driver, city_id, temp_bin_c as bin, round(avg(pm2_5), 1) as pm25_avg, count(*) as n_hours
from binned group by all having count(*) >= 48
union all
select 'wind' as driver, city_id, wind_bin_kmh as bin, round(avg(pm2_5), 1) as pm25_avg, count(*) as n_hours
from binned group by all having count(*) >= 48
