SELECT
  NULL AS plain_null,
  CAST(NULL AS INT64) AS typed_null,
  IFNULL(NULL, 'fallback') AS ifnull_str,
  COALESCE(NULL, NULL, 42) AS coalesce_int,
  NULLIF(1, 1) AS nullif_eq
