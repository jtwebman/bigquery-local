SELECT
  x,
  x - (SELECT AVG(y) FROM UNNEST([10, 20, 30]) AS y) AS diff_from_avg
FROM UNNEST([10, 20, 30]) AS x
ORDER BY x
