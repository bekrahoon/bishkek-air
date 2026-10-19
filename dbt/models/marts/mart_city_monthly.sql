select
    city_id,
    city_name,
    date_trunc('month', date_local)::date as month,
    round(avg(pm25_avg), 1)               as pm25_avg,
    round(max(pm25_avg), 1)               as pm25_worst_day,
    count(*)                              as days_observed,
    count(*) filter (where exceeds_who_pm25) as days_over_who,
    round(avg(temp_avg_c), 1)             as temp_avg_c
from {{ ref('mart_city_daily') }}
group by all
