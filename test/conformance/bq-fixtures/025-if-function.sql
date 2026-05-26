SELECT
  x,
  IF(x > 1, 'big', 'small') AS size,
  IF(x = 0, NULL, 100 / x) AS div_safe
FROM UNNEST([0, 1, 2, 5]) AS x
ORDER BY x
