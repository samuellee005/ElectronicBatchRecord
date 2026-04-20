<?php
/**
 * Configuration file for PDF Background Template Application
 */

// Directory where uploaded PDFs will be stored
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

// Active users for collaborator dropdowns (JSON array)
define('ACTIVE_USERS_FILE', DATA_DIR . 'active-users.json');

require_once __DIR__ . '/includes/db.php';
