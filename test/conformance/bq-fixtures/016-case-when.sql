SELECT
  x,
  CASE
    WHEN x > 1 THEN 'big'
    WHEN x = 1 THEN 'one'
    ELSE 'small'
  END AS label
FROM UNNEST([0, 1, 2, 3]) AS x
ORDER BY x
