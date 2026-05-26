WITH nums AS (
  SELECT x FROM UNNEST([10, 20, 30]) AS x
),
doubled AS (
  SELECT x * 2 AS y FROM nums
)
SELECT SUM(y) AS total FROM doubled
