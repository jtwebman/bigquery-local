SELECT
  COUNT(*) AS n,
  SUM(x) AS total,
  STRING_AGG(CAST(x AS STRING), ',' ORDER BY x) AS list
FROM UNNEST([1, 2, 3, 4, 5]) AS x
