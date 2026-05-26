SELECT
  STARTS_WITH('hello world', 'hello') AS starts,
  ENDS_WITH('hello world', 'world') AS ends,
  STRPOS('hello world', 'world') AS pos,
  REPLACE('aaa', 'a', 'b') AS replaced,
  LOWER('HELLO') AS lowered,
  UPPER('hello') AS uppered,
  LENGTH('hello') AS len,
  CHAR_LENGTH('héllo') AS char_len
