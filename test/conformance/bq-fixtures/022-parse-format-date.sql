SELECT
  PARSE_DATE('%Y-%m-%d', '2025-06-15') AS parsed,
  FORMAT_DATE('%Y-%m-%d', DATE '2025-06-15') AS formatted,
  FORMAT_DATE('%A, %B %d', DATE '2025-06-15') AS pretty
