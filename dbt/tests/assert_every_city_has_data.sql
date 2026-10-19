select c.city_id
from {{ ref('cities') }} c
left join {{ ref('mart_city_summary') }} s using (city_id)
where s.city_id is null
