SELECT elem, idx
FROM UNNEST(['a', 'b', 'c']) AS elem WITH OFFSET AS idx
ORDER BY idx
