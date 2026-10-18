-- Open-slot pickup requests (from pickup share links) reuse shift_requests
-- with a new 'open_pickup' type. Approve publishes the held shift; decline deletes it.
ALTER TABLE shift_requests DROP CONSTRAINT IF EXISTS shift_requests_request_type_check;
ALTER TABLE shift_requests ADD CONSTRAINT shift_requests_request_type_check
  CHECK (request_type IN ('pickup', 'swap', 'open_pickup'));
