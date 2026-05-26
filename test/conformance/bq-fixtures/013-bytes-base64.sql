SELECT
  b'hello' AS b_literal,
  FROM_BASE64('d29ybGQ=') AS b_decoded,
  TO_BASE64(b'world') AS b64_encoded
