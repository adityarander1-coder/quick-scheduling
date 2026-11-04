-- Request expiry (Deepika 2026-11-03): pending shift requests whose
-- shift day has passed close as 'expired' (15-minute sweep in
-- util/notifyJobs.ts), so the status value must be allowed.
ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_status_check;
ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_status_check
  CHECK (status IN ('pending', 'approved', 'declined', 'cancelled', 'expired'));
