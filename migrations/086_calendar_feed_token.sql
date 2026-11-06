-- 086_calendar_feed_token.sql
-- Personal calendar feed (Deepika, 2026-11-06): every user can expose
-- a private, unguessable .ics feed of their own published shifts and
-- the sessions they present or supervise, so Google / Outlook / Apple
-- Calendar can subscribe to it. The token IS the credential for the
-- public feed endpoint — resetting it invalidates the old URL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendar_feed_token text UNIQUE;
