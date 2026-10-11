-- Secure tokens for email candidate review links
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS review_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_candidates_review_token ON candidates(review_token);
