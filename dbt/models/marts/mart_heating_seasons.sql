-- Heating season = November..March. "2024/25" covers Nov 2024 - Mar 2025.
with daily as (
    select
        *,
        case
            when month(date_local) >= 11 then year(date_local)
            when month(date_local) <= 3  then year(date_local) - 1
        end as season_start_year
    from {{ ref('mart_city_daily') }}
)
select
    city_id,
    city_name,
    season_start_year,
    season_start_year || '/' || right(cast(season_start_year + 1 as varchar), 2) as season,
    round(avg(pm25_avg), 1)                      as pm25_avg,
    count(*)                                     as days_observed,
    count(*) filter (where exceeds_who_pm25)     as days_over_who,
    round(max(pm25_avg), 1)                      as worst_day_pm25,
    arg_max(date_local, pm25_avg)                as worst_day
from daily
where season_start_year is not null
group by all
-- only (nearly) complete seasons: Nov-Mar has 151 days
having count(*) >= 120
