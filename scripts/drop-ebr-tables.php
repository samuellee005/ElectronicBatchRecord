<?php

declare(strict_types=1);

/**
 * Drop all ebr_* application tables (requires ownership or superuser).
 * Usage: docker compose run --rm ebr php /app/scripts/drop-ebr-tables.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

$pdo = ebr_pg_pdo();
foreach (['ebr_data_entries', 'ebr_batch_records', 'ebr_forms', 'ebr_active_users'] as $table) {
    $pdo->exec('DROP TABLE IF EXISTS ' . $table . ' CASCADE');
}
echo 'Dropped ebr_* tables on database ' . ebr_resolve_pg_database() . ".\n";
