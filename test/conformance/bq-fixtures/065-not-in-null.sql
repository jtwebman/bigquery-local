SELECT
  5 IN (1, 2, 3) AS in_present,
  5 IN (1, 2, 5) AS in_match,
  5 NOT IN (1, 2, 3) AS not_in_absent,
  5 IN (1, 2, NULL) AS in_with_null,
  5 NOT IN (1, 2, NULL) AS not_in_with_null
