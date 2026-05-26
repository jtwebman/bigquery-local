SELECT
  COUNT(*) AS rows_total,
  COUNT(x) AS rows_non_null,
  SUM(x) AS sum_x,
  AVG(x) AS avg_x,
  MIN(x) AS min_x,
  MAX(x) AS max_x
FROM UNNEST([1, NULL, 2, NULL, 3]) AS x
