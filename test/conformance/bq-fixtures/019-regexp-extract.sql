SELECT
  REGEXP_EXTRACT('hello123world', r'\d+') AS num,
  REGEXP_EXTRACT('user@example.com', r'@(.+)') AS domain,
  REGEXP_CONTAINS('hello', r'^h') AS starts_with_h,
  REGEXP_REPLACE('hello world', r'world', 'BQ') AS replaced
