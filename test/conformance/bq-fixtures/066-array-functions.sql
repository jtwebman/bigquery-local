SELECT
  ARRAY_LENGTH([1, 2, 3, 4]) AS len,
  ARRAY_REVERSE([1, 2, 3]) AS reversed,
  ARRAY_CONCAT([1, 2], [3, 4]) AS concatenated,
  [10, 20, 30][SAFE_OFFSET(1)] AS safe_in_range,
  [10, 20, 30][SAFE_OFFSET(99)] AS safe_out_of_range,
  ARRAY_TO_STRING(['a', 'b', 'c'], '-') AS joined
