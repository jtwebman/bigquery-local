{{ config(materialized='table') }}
select 1 as id, 'alice' as name
union all
select 2 as id, 'bob' as name
