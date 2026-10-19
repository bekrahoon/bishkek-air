{# Wall-clock time of the run in UTC, as a literal so results are reproducible
   and independent of the DuckDB session time zone. #}
{% macro utc_now() -%}
  timestamp '{{ modules.datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S") }}'
{%- endmacro %}

{# US EPA AQI categories. #}
{% macro aqi_category(col) -%}
  case
    when {{ col }} is null then null
    when {{ col }} <= 50  then 'Good'
    when {{ col }} <= 100 then 'Moderate'
    when {{ col }} <= 150 then 'Unhealthy for sensitive groups'
    when {{ col }} <= 200 then 'Unhealthy'
    when {{ col }} <= 300 then 'Very unhealthy'
    else 'Hazardous'
  end
{%- endmacro %}

{% macro lake(source) -%}
  read_parquet('{{ var("lake_dir") }}/{{ source }}/*/*.parquet', union_by_name = true, hive_partitioning = false)
{%- endmacro %}
