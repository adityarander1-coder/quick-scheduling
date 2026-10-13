-- Employee self-service: pickup and swap requests.
-- A 'pickup' request asks someone (or anyone, when target_user_id IS NULL) to
-- take over one manual shift. A 'swap' request proposes exchanging the owners
-- of two manual shifts (shift_id owned by the requester, their_shift_id owned
-- by the target).
-- Only real (manual) shift rows can be requested — rotation-generated schedule
-- entries have no shift row and must be handled by a scheduler instead.

CREATE TABLE IF NOT EXISTS shift_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN ('pickup', 'swap')),
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  their_shift_id uuid NULL REFERENCES shifts(id) ON DELETE CASCADE,
  requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_requests_company_status
  ON shift_requests (company_id, status);
CREATE INDEX IF NOT EXISTS idx_shift_requests_target_status
  ON shift_requests (target_user_id, status);
CREATE INDEX IF NOT EXISTS idx_shift_requests_requester
  ON shift_requests (requester_id);
