{{ config(materialized='incremental', unique_key='id') }}
select id, name from {{ ref('my_model') }}
{% if is_incremental() %}
where id > (select coalesce(max(id), 0) from {{ this }})
{% endif %}
