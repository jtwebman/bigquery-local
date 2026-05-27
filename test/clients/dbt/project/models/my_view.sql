{{ config(materialized='view') }}
select id, upper(name) as name_upper from {{ ref('my_model') }}
