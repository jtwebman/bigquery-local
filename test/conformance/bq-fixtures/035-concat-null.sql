SELECT
  CONCAT('a', 'b', 'c') AS all_present,
  CONCAT('a', CAST(NULL AS STRING), 'c') AS with_null,
  CONCAT('x') AS single,
  'a' || 'b' AS pipe_concat
