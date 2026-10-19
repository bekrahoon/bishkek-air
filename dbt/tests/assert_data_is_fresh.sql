-- Fails (as a warning) if no city has an observation in the last 3 days:
-- that would mean the upstream API or our schedule is broken.
{{ config(severity='warn') }}
select max(ts_utc) as latest
from {{ ref('fct_air_hourly') }}
having max(ts_utc) < {{ utc_now() }} - interval 3 day
