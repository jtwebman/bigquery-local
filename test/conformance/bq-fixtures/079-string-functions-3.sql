SELECT
  TRANSLATE('abcabc', 'ac', 'xz') AS translated,
  SPLIT('a,b,,c', ',') AS split_with_empty,
  REGEXP_EXTRACT_ALL('a1b2c3', r'[0-9]') AS all_digits,
  LTRIM('   hi') AS ltrimmed,
  RTRIM('hi   ') AS rtrimmed
