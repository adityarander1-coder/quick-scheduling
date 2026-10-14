-- 037_company_industry.sql — industry picker at signup; seeds matching example shifts.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry text;
