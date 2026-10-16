-- Free-form additional emails per department for Email AI notifications.
ALTER TABLE department_notification_settings ADD COLUMN IF NOT EXISTS extra_emails text[] NOT NULL DEFAULT '{}';
