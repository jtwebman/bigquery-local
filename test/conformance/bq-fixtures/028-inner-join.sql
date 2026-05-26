WITH a AS (
  SELECT 1 AS id, 'Alice' AS name UNION ALL
  SELECT 2, 'Bob' UNION ALL
  SELECT 3, 'Carol'
),
b AS (
  SELECT 1 AS id, 90 AS score UNION ALL
  SELECT 2, 85 UNION ALL
  SELECT 4, 70
)
SELECT a.id, a.name, b.score
FROM a INNER JOIN b ON a.id = b.id
ORDER BY a.id
