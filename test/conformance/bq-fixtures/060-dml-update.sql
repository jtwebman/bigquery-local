CREATE OR REPLACE TEMP TABLE items (id INT64, qty INT64);
INSERT INTO items VALUES (1, 10), (2, 20), (3, 30);
UPDATE items SET qty = qty * 2 WHERE id <= 2;
SELECT id, qty FROM items ORDER BY id;
