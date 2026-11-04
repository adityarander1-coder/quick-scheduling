-- Credential documents (Deepika 2026-11-04): the uploaded license /
-- certificate file itself, stored with the credential it belongs to.
-- One current document per credential (re-uploading replaces). The
-- bytes live in the database so they survive the host's ephemeral disk.
CREATE TABLE IF NOT EXISTS credential_documents (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  credential_id UUID NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  data BYTEA NOT NULL,
  uploaded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credential_documents_credential
  ON credential_documents (credential_id, created_at DESC);
