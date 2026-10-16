-- Per-department Email AI notification recipients.
CREATE TABLE IF NOT EXISTS department_notification_settings (
  department_id uuid PRIMARY KEY REFERENCES departments(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  primary_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  cc_user_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
