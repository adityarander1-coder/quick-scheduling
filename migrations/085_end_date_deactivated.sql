-- 085_end_date_deactivated.sql
-- End date drives account status (Deepika, 2026-11-05): when a team
-- member's end date passes, their account becomes inactive on its own.
-- This flag marks accounts the end-date logic deactivated (as opposed
-- to a manual deactivation), so extending or clearing the end date can
-- reactivate exactly those accounts — and never resurrects someone an
-- owner deactivated by hand.
ALTER TABLE users ADD COLUMN IF NOT EXISTS end_date_deactivated boolean NOT NULL DEFAULT false;
