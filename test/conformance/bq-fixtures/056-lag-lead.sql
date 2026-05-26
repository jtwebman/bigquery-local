WITH t AS (
  SELECT 1 AS x UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
)
SELECT
  x,
  LAG(x) OVER (ORDER BY x) AS prev_default,
  LAG(x, 2, -1) OVER (ORDER BY x) AS prev_2_with_default,
  LEAD(x) OVER (ORDER BY x) AS next_default,
  LEAD(x, 1, 99) OVER (ORDER BY x) AS next_with_default
FROM t
ORDER BY x
