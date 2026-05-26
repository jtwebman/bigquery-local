CREATE OR REPLACE TEMP TABLE target (id INT64, val STRING);
INSERT INTO target VALUES (1, 'old'), (2, 'old');
CREATE OR REPLACE TEMP TABLE source (id INT64, val STRING);
INSERT INTO source VALUES (2, 'new'), (3, 'new');
MERGE INTO target T
USING source S ON T.id = S.id
WHEN MATCHED THEN UPDATE SET val = S.val
WHEN NOT MATCHED THEN INSERT (id, val) VALUES (S.id, S.val);
SELECT id, val FROM target ORDER BY id;
