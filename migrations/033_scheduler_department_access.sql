-- Scheduler department access: which departments each scheduler may view or edit.
-- Owner bypasses all department checks entirely. Schedulers with no rows see
-- nothing (they gain access only when the owner assigns it). 'edit' implies 'view'.

CREATE TABLE IF NOT EXISTS scheduler_department_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  access_level text NOT NULL CHECK (access_level IN ('view', 'edit')),
  UNIQUE (user_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_sched_dept_access_company ON scheduler_department_access(company_id);
CREATE INDEX IF NOT EXISTS idx_sched_dept_access_user ON scheduler_department_access(user_id);

-- Backfill: every existing scheduler gets 'edit' on every department in their
-- company, so nothing breaks for current schedulers.
INSERT INTO scheduler_department_access (company_id, user_id, department_id, access_level)
SELECT u.company_id, u.id, d.id, 'edit'
FROM users u
JOIN departments d ON d.company_id = u.company_id
WHERE u.role = 'scheduler'
ON CONFLICT (user_id, department_id) DO NOTHING;
