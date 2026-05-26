WITH sales AS (
  SELECT 'east' AS region, 'q1' AS quarter, 10 AS amt UNION ALL
  SELECT 'east', 'q2', 20 UNION ALL
  SELECT 'west', 'q1', 30 UNION ALL
  SELECT 'west', 'q2', 40
)
SELECT * FROM sales
PIVOT (SUM(amt) FOR quarter IN ('q1', 'q2'))
ORDER BY region
