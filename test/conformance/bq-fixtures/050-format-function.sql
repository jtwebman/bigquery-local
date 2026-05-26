SELECT
  FORMAT('%d apples', 5) AS int_fmt,
  FORMAT('%s = %d', 'count', 42) AS multi,
  FORMAT('%.2f', CAST(3.14159 AS FLOAT64)) AS float_fmt,
  FORMAT('%05d', 42) AS padded,
  FORMAT('%x', 255) AS hex_fmt
