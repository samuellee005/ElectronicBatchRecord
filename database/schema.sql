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
