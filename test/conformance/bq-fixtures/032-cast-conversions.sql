SELECT
  CAST(3.7 AS INT64) AS float_to_int,
  CAST(-3.7 AS INT64) AS neg_float_to_int,
  CAST(42 AS STRING) AS int_to_string,
  CAST('123' AS INT64) AS string_to_int,
  CAST(TRUE AS STRING) AS bool_to_string,
  CAST(TRUE AS INT64) AS bool_to_int
