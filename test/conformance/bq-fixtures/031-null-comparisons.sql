WITH n AS (SELECT CAST(NULL AS INT64) AS v)
SELECT
  v = v AS null_eq_null,
  v IS NULL AS null_is_null,
  v IS NOT NULL AS null_is_not_null,
  1 = v AS one_eq_null,
  CAST(NULL AS BOOL) AND TRUE AS null_and_true,
  CAST(NULL AS BOOL) OR TRUE AS null_or_true
FROM n
