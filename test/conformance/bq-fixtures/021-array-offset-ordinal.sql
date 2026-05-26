SELECT
  ['a', 'b', 'c', 'd'][OFFSET(0)] AS first_offset,
  ['a', 'b', 'c', 'd'][OFFSET(2)] AS third_offset,
  ['a', 'b', 'c', 'd'][ORDINAL(1)] AS first_ordinal,
  ['a', 'b', 'c', 'd'][ORDINAL(3)] AS third_ordinal,
  ['a', 'b', 'c'][SAFE_OFFSET(10)] AS out_of_range
