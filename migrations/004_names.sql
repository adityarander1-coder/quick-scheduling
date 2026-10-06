-- 004_names.sql — split users.name into first_name / last_name.
-- Runs in filename order via src/db.ts migration runner.
-- The `name` column is kept as a populated display value for backward
-- compatibility; new writes set first_name, last_name, AND name.

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text;

-- Backfill from the old single `name` column: first token -> first_name,
-- remainder -> last_name. Single-token names get last_name = ''.
UPDATE users
SET
  first_name = split_part(trim(name), ' ', 1),
  last_name = CASE
    WHEN position(' ' in trim(name)) > 0
    THEN trim(substring(trim(name) from position(' ' in trim(name)) + 1))
    ELSE ''
  END
WHERE first_name IS NULL;
