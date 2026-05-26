SELECT
  COALESCE(NULL, NULL, 3, 4) AS first_non_null,
  GREATEST(1, 5, 3, 2) AS max_val,
  LEAST(1, 5, 3, 2) AS min_val,
  GREATEST(1, NULL, 3) AS greatest_with_null
