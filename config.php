<?php
/**
 * Configuration file for PDF Background Template Application
 */

/**
 * Load project root `.env` when present so `php -S … router.php` picks up EBR_* without Docker.
 * Does not override variables already set in the process environment.
 */
function ebr_load_dotenv_if_readable(): void
{
    $path = __DIR__ . '/.env';
    if (!is_readable($path)) {
        return;
    }
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if ($lines === false) {
        return;
    }
    foreach ($lines as $line) {
        $t = trim($line);
        if ($t === '' || str_starts_with($t, '#')) {
            continue;
        }
        if (!str_contains($t, '=')) {
            continue;
        }
        [$name, $value] = explode('=', $t, 2);
        $name = trim($name);
        $value = trim($value);
        if ($name === '') {
            continue;
        }
        if ($value !== '' && str_starts_with($value, '"') && str_ends_with($value, '"')) {
            $value = substr($value, 1, -1);
        } elseif ($value !== '' && str_starts_with($value, "'") && str_ends_with($value, "'")) {
            $value = substr($value, 1, -1);
        }
        if (getenv($name) !== false) {
            continue;
        }
        putenv($name . '=' . $value);
        $_ENV[$name] = $value;
    }
}

ebr_load_dotenv_if_readable();

// Legacy disk path (optional); template bytes are stored in PostgreSQL (ebr_pdf_templates). GET /uploads/*.pdf is served from the DB via router.php.
define('UPLOAD_DIR', __DIR__ . '/uploads/');

// Directory where form configurations will be stored
define('FORMS_DIR', __DIR__ . '/forms/');

// Directory where data entries will be stored
define('DATA_DIR', __DIR__ . '/data/');

// Directory where batch record metadata is stored (title, description, status)
define('BATCH_RECORDS_DIR', __DIR__ . '/data/batch-records/');

// Maximum file size in bytes (10MB)
define('MAX_FILE_SIZE', 10 * 1024 * 1024);

// Allowed file types
define('ALLOWED_EXTENSIONS', ['pdf']);

// Enable error reporting (disable in production)
error_reporting(E_ALL);
ini_set('display_errors', 1);

// Create upload directory if it doesn't exist
if (!file_exists(UPLOAD_DIR)) {
    mkdir(UPLOAD_DIR, 0755, true);
}

// Create .gitkeep file to preserve directory in git
if (!file_exists(UPLOAD_DIR . '.gitkeep')) {
    file_put_contents(UPLOAD_DIR . '.gitkeep', '');
}

// Create forms directory if it doesn't exist
if (!file_exists(FORMS_DIR)) {
    mkdir(FORMS_DIR, 0755, true);
    file_put_contents(FORMS_DIR . '.gitkeep', '');
}

// Create data directory if it doesn't exist
if (!file_exists(DATA_DIR)) {
    mkdir(DATA_DIR, 0755, true);
    file_put_contents(DATA_DIR . '.gitkeep', '');
}
if (!file_exists(BATCH_RECORDS_DIR)) {
    mkdir(BATCH_RECORDS_DIR, 0755, true);
    file_put_contents(BATCH_RECORDS_DIR . '.gitkeep', '');
}

// Legacy path: list-active-users migrates this file into ebr_active_users once if the table is empty
define('ACTIVE_USERS_FILE', DATA_DIR . 'active-users.json');

/**
 * When false (default), legacy JSON under FORMS_DIR / DATA_DIR is not read as a fallback — only PostgreSQL.
 * Set EBR_LEGACY_JSON_FALLBACK=1 during migration from file-based storage.
 */
function ebr_legacy_json_fallback_enabled(): bool
{
    $v = getenv('EBR_LEGACY_JSON_FALLBACK');
    if ($v === false || $v === '') {
        return false;
    }
    $s = strtolower(trim((string) $v));

    return $s === '1' || $s === 'true' || $s === 'yes';
}

/**
 * Verbose error_log (and optional JSON debugInfo) for save-data / update-batch.
 * Set EBR_DEBUG_SAVE=1 in the environment.
 */
function ebr_debug_save_enabled(): bool
{
    $v = getenv('EBR_DEBUG_SAVE');
    if ($v === false || $v === '') {
        return false;
    }
    $s = strtolower(trim((string) $v));

    return $s === '1' || $s === 'true' || $s === 'yes';
}

require_once __DIR__ . '/includes/db.php';
