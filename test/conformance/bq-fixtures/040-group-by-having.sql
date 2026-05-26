WITH sales AS (
  SELECT 'east' AS region, 10 AS amt UNION ALL
  SELECT 'east', 20 UNION ALL
  SELECT 'west', 30 UNION ALL
  SELECT 'west', 5 UNION ALL
  SELECT 'north', 100
)
SELECT region, SUM(amt) AS total
FROM sales
GROUP BY region
HAVING SUM(amt) > 25
ORDER BY region
