SELECT
  JSON_VALUE('{"a":{"b":"hello"}}', '$.a.b') AS nested_string,
  JSON_VALUE('{"x":[10,20,30]}', '$.x[1]') AS array_idx,
  JSON_VALUE('{"k":null}', '$.k') AS null_val,
  JSON_VALUE('{"k":42}', '$.missing') AS missing_path
