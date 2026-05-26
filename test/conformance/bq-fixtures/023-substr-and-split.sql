SELECT
  SUBSTR('hello world', 1, 5) AS first_five,
  SUBSTR('hello world', 7) AS rest,
  SUBSTR('hello', -3) AS last_three,
  SPLIT('a,b,c,d', ',') AS parts
