WITH dept AS (
  SELECT 1 AS id, 'eng' AS name UNION ALL
  SELECT 2, 'sales'
),
emp AS (
  SELECT 1 AS dept_id, 100 AS salary UNION ALL
  SELECT 1, 120 UNION ALL
  SELECT 2, 90
)
SELECT
  name,
  (SELECT COUNT(*) FROM emp WHERE emp.dept_id = dept.id) AS headcount,
  (SELECT SUM(salary) FROM emp WHERE emp.dept_id = dept.id) AS payroll
FROM dept
ORDER BY id
