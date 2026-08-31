---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_pdf_templates (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL DEFAULT '',
    content BYTEA NOT NULL,
    file_size INTEGER NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_pdf_templates_uploaded ON ebr_pdf_templates (uploaded_at DESC);

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_pdf_template_suggestions (
    filename TEXT PRIMARY KEY,
    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_forms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pdf_file TEXT NOT NULL DEFAULT '',
    fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    version NUMERIC(10, 2) NOT NULL DEFAULT 1.0,
    is_latest BOOLEAN NOT NULL DEFAULT TRUE,
    source_form_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_combined BOOLEAN NOT NULL DEFAULT FALSE,
    audit_trail JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    created_by TEXT,
    updated_by TEXT,
    storage_filename TEXT
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_forms_name_pdf ON ebr_forms (name, pdf_file);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_forms_is_latest ON ebr_forms (is_latest) WHERE is_latest = TRUE;

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_batch_records (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    form_name TEXT NOT NULL DEFAULT '',
    pdf_file TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    created_by TEXT,
    last_entry_id TEXT,
    last_entry_filename TEXT,
    completed_sign_off_by TEXT,
    completed_sign_off_at TEXT,
    CONSTRAINT fk_ebr_batch_form FOREIGN KEY (form_id) REFERENCES ebr_forms (id) ON DELETE RESTRICT
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_batch_status ON ebr_batch_records (status);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_batch_form_id ON ebr_batch_records (form_id);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_batch_created_by ON ebr_batch_records (created_by);

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_data_entries (
    id TEXT PRIMARY KEY,
    form_id TEXT NOT NULL,
    form_name TEXT NOT NULL DEFAULT '',
    pdf_file TEXT NOT NULL DEFAULT '',
    batch_id TEXT REFERENCES ebr_batch_records (id) ON DELETE SET NULL,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    stage_completion JSONB NOT NULL DEFAULT '[]'::jsonb,
    stages JSONB NOT NULL DEFAULT '[]'::jsonb,
    saved_at TIMESTAMPTZ NOT NULL,
    storage_filename TEXT,
    CONSTRAINT fk_ebr_data_entries_form FOREIGN KEY (form_id) REFERENCES ebr_forms (id) ON DELETE RESTRICT
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_data_form_id ON ebr_data_entries (form_id);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_data_batch_id ON ebr_data_entries (batch_id);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_data_saved_at ON ebr_data_entries (saved_at DESC);

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_active_users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_active_users_active ON ebr_active_users (active);

---STATEMENT---
CREATE TABLE IF NOT EXISTS ebr_user_preferences (
    user_key TEXT PRIMARY KEY,
    prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_user_preferences_updated ON ebr_user_preferences (updated_at DESC);

-- db_user: shared enterprise login table (see database/db_user.sql). This app only SELECTs it; do not create it here.

---STATEMENT---
-- Link the EBR collaborator roster to real accounts in `db_user` so a person can be
-- re-authenticated (Live Collab). Legacy rows keep NULL and are not selectable as collaborators.
ALTER TABLE ebr_active_users ADD COLUMN IF NOT EXISTS db_user_id INTEGER;

---STATEMENT---
ALTER TABLE ebr_active_users ADD COLUMN IF NOT EXISTS username TEXT;

---STATEMENT---
CREATE UNIQUE INDEX IF NOT EXISTS idx_ebr_active_users_db_user_id
    ON ebr_active_users (db_user_id) WHERE db_user_id IS NOT NULL;

---STATEMENT---
-- People designated on a batch at creation time. Membership is never hard-deleted:
-- removal sets removed_at so the record retains who was on it and when.
CREATE TABLE IF NOT EXISTS ebr_batch_collaborators (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES ebr_batch_records (id) ON DELETE CASCADE,
    db_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    added_by_user_id INTEGER,
    added_by_username TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_by_user_id INTEGER,
    removed_by_username TEXT,
    removed_at TIMESTAMPTZ
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_batch_collab_batch ON ebr_batch_collaborators (batch_id);

---STATEMENT---
CREATE UNIQUE INDEX IF NOT EXISTS idx_ebr_batch_collab_active
    ON ebr_batch_collaborators (batch_id, db_user_id) WHERE removed_at IS NULL;

---STATEMENT---
-- Live Collab presence ledger: one row per credential verification. Fixed window —
-- verified at verified_at, valid until expires_at, no sliding extension.
CREATE TABLE IF NOT EXISTS ebr_batch_presence (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES ebr_batch_records (id) ON DELETE CASCADE,
    db_user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    verified_ip TEXT,
    verified_by_session_user_id INTEGER
);

---STATEMENT---
CREATE INDEX IF NOT EXISTS idx_ebr_batch_presence_batch ON ebr_batch_presence (batch_id, expires_at DESC);

---STATEMENT---
-- Server-derived attribution on saved entries (previously no user was recorded at all).
ALTER TABLE ebr_data_entries ADD COLUMN IF NOT EXISTS saved_by_user_id INTEGER;

---STATEMENT---
ALTER TABLE ebr_data_entries ADD COLUMN IF NOT EXISTS saved_by_username TEXT;

---STATEMENT---
ALTER TABLE ebr_batch_records ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER;

---STATEMENT---
ALTER TABLE ebr_batch_records ADD COLUMN IF NOT EXISTS completed_sign_off_user_id INTEGER;

---STATEMENT---
-- How presence was established: 'password' = the person re-entered their own credentials
-- (another collaborator at a shared machine); 'session' = they are the signed-in user, whose
-- identity was already proved at login. Both attribute entries; the record keeps which it was.
ALTER TABLE ebr_batch_presence ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'password';
