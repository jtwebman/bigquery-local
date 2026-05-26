CREATE OR REPLACE TEMP TABLE items (id INT64, name STRING);
INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c');
SELECT id, name FROM items ORDER BY id;
