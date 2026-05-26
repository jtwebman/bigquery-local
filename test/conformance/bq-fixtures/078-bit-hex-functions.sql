SELECT
  TO_HEX(b'abc') AS hex_encoded,
  FROM_HEX('616263') AS hex_decoded,
  BIT_COUNT(255) AS bits_set,
  12 & 10 AS bit_and,
  12 | 10 AS bit_or,
  1 << 4 AS shift_left
