SELECT
  JSON_EXTRACT('{"a":{"b":1}}', '$.a') AS extract_obj,
  JSON_EXTRACT_SCALAR('{"a":"hi"}', '$.a') AS extract_scalar,
  JSON_QUERY('{"x":[1,2,3]}', '$.x') AS query_arr,
  JSON_VALUE('{"n":42}', '$.n') AS value_n,
  TO_JSON_STRING(STRUCT(1 AS id, 'name' AS label)) AS to_json,
  JSON_TYPE(JSON '{"k":1}') AS json_type
