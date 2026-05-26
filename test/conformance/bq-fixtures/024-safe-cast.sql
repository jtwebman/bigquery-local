SELECT
  SAFE_CAST('42' AS INT64) AS good_int,
  SAFE_CAST('not a number' AS INT64) AS bad_int,
  SAFE_CAST('3.14' AS FLOAT64) AS good_float,
  SAFE_CAST('abc' AS FLOAT64) AS bad_float,
  SAFE_CAST('2025-06-15' AS DATE) AS good_date,
  SAFE_CAST('not-a-date' AS DATE) AS bad_date
