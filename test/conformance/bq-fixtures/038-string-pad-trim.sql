SELECT
  LPAD('5', 3, '0') AS lpadded,
  RPAD('5', 3, '0') AS rpadded,
  TRIM('  hello  ') AS trimmed,
  LTRIM('xxhello', 'x') AS ltrimmed,
  REPEAT('ab', 3) AS repeated,
  REVERSE('hello') AS reversed
