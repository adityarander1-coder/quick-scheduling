-- Per-company Email AI notification preferences.
CREATE TABLE IF NOT EXISTS company_notification_settings (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  notify_owner boolean NOT NULL DEFAULT true,
  notify_schedulers boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
