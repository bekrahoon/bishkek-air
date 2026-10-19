-- One row per city: the headline numbers shown on the dashboard.
with h as (select * from {{ ref('int_air_hourly') }}),
d as (select * from {{ ref('mart_city_daily') }}),

latest as (
    select city_id, arg_max(ts_local, ts_utc) as latest_ts_local, arg_max(pm2_5, ts_utc) as pm25_now,
           arg_max(us_aqi, ts_utc) as aqi_now, max(ts_utc) as latest_ts_utc
    from h group by city_id
),
last24 as (
    select h.city_id, round(avg(h.pm2_5), 1) as pm25_24h
    from h join latest l using (city_id)
    where h.ts_utc > l.latest_ts_utc - interval 24 hour
    group by h.city_id
),
windows as (
    select
        d.city_id,
        max(d.date_local) as last_day,
        round(avg(d.pm25_avg) filter (where d.date_local > l.last_day - 30), 1)  as pm25_30d,
        round(avg(d.pm25_avg) filter (where d.date_local > l.last_day - 365), 1) as pm25_365d,
        count(*) filter (where d.date_local > l.last_day - 365 and d.exceeds_who_pm25) as days_over_who_365d,
        count(*) filter (where d.date_local > l.last_day - 365) as days_observed_365d,
        arg_max(d.date_local, d.pm25_avg) as worst_day,
        max(d.pm25_avg) as worst_day_pm25
    from d
    join (select city_id, max(date_local) as last_day from d group by city_id) l using (city_id)
    group by d.city_id
)

select
    c.city_id,
    c.city_name,
    c.country,
    c.latitude,
    c.longitude,
    c.is_focus,
    l.latest_ts_local,
    round(l.pm25_now, 1)          as pm25_now,
    round(l.aqi_now, 0)           as aqi_now,
    {{ aqi_category('l.aqi_now') }} as aqi_category_now,
    t.pm25_24h,
    w.pm25_30d,
    w.pm25_365d,
    round(w.pm25_365d / {{ var('who_pm25_annual') }}, 1) as times_who_annual,
    w.days_over_who_365d,
    w.days_observed_365d,
    w.worst_day,
    w.worst_day_pm25,
    rank() over (order by w.pm25_30d desc) as rank_30d
from {{ ref('cities') }} c
join latest l using (city_id)
left join last24 t using (city_id)
left join windows w using (city_id)
