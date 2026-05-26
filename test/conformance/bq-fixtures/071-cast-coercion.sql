SELECT
  CAST(' 42 ' AS INT64) AS whitespace_int,
  CAST('-17' AS INT64) AS negative_int,
  CAST(TRUE AS INT64) AS bool_to_int,
  CAST(0 AS BOOL) AS zero_to_bool,
  CAST(1 AS BOOL) AS one_to_bool,
  CAST('3.99' AS FLOAT64) AS string_to_float
