SELECT
  10 / 4 AS int_div_returns_float,
  9 / 3 AS exact_div,
  CAST(10 / 4 AS FLOAT64) AS explicit_float,
  CAST(7 AS FLOAT64) / 2 AS float_div
