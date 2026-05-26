CREATE OR REPLACE TEMP TABLE items (id INT64, active BOOL);
INSERT INTO items VALUES (1, true), (2, false), (3, true), (4, false);
DELETE FROM items WHERE active = false;
SELECT id FROM items ORDER BY id;
