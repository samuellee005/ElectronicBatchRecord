<?php

declare(strict_types=1);

/**
 * PostgreSQL persistence for ebr_batch_records (replaces JSON files in data/batch-records/).
 */

require_once __DIR__ . '/db.php';

/**
 * @param mixed $v
 */
function ebr_db_ts_to_iso($v): ?string
{
    if ($v === null || $v === '') {
        return null;
    }
    if ($v instanceof \DateTimeInterface) {
        return $v->format('c');
    }

    return (string) $v;
}

/** TIMESTAMPTZ NOT NULL — never pass empty string. */
function ebr_db_batch_ts_param($v): string
{
    if ($v instanceof \DateTimeInterface) {
        return $v->format('c');
    }
    $s = trim((string) $v);
    if ($s === '') {
        return date('c');
    }

    return $s;
}

/** Nullable timestamptz (completed_at, sign-off). */
function ebr_db_batch_ts_nullable_param($v): ?string
{
    if ($v === null) {
        return null;
    }
    if ($v instanceof \DateTimeInterface) {
        return $v->format('c');
    }
    $s = trim((string) $v);
    if ($s === '') {
        return null;
    }

    return $s;
}

/**
 * @param array<string, mixed> $row PDO FETCH_ASSOC row from ebr_batch_records
 * @return array<string, mixed>
 */
function ebr_db_batch_row_to_api(array $row): array
{
    return [
        'id' => $row['id'],
        'batchId' => $row['id'],
        'formId' => $row['form_id'],
        'formName' => $row['form_name'],
        'pdfFile' => $row['pdf_file'],
        'title' => $row['title'],
        'description' => $row['description'],
        'status' => $row['status'],
        'createdAt' => ebr_db_ts_to_iso($row['created_at'] ?? null) ?? '',
        'updatedAt' => ebr_db_ts_to_iso($row['updated_at'] ?? null) ?? '',
        'completedAt' => ebr_db_ts_to_iso($row['completed_at'] ?? null),
        'createdBy' => $row['created_by'],
        'lastEntryId' => $row['last_entry_id'],
        'lastEntryFilename' => $row['last_entry_filename'],
        'completedSignOffBy' => $row['completed_sign_off_by'],
        'completedSignOffAt' => $row['completed_sign_off_at'],
    ];
}

/**
 * Highest numeric suffix for BR-{year}-{initials}-NNNNN in the database.
 */
function ebr_db_batch_max_sequence(string $year, string $initials): int
{
    $pdo = ebr_pg_pdo();
    $pattern = 'BR-' . $year . '-' . $initials . '-%';
    $sql = 'SELECT COALESCE(MAX(CAST(RIGHT(id, 5) AS INTEGER)), 0) FROM ebr_batch_records WHERE id LIKE :p';
    $st = $pdo->prepare($sql);
    $st->execute(['p' => $pattern]);
    $n = $st->fetchColumn();
    if ($n === false || $n === null) {
        return 0;
    }

    return (int) $n;
}

/**
 * @param array<string, mixed> $record API-shaped batch (from create-batch-record)
 */
function ebr_db_batch_insert(array $record): void
{
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
INSERT INTO ebr_batch_records (
    id, form_id, form_name, pdf_file, title, description, status,
    created_at, updated_at, completed_at, created_by,
    last_entry_id, last_entry_filename, completed_sign_off_by, completed_sign_off_at
) VALUES (
    :id, :form_id, :form_name, :pdf_file, :title, :description, :status,
    :created_at, :updated_at, :completed_at, :created_by,
    :last_entry_id, :last_entry_filename, :completed_sign_off_by, :completed_sign_off_at
)
SQL;
    $st = $pdo->prepare($sql);
    $cb = $record['createdBy'] ?? null;
    $cb = ($cb !== null && trim((string) $cb) !== '') ? trim((string) $cb) : null;

    $st->execute([
        'id' => $record['id'],
        'form_id' => $record['formId'],
        'form_name' => $record['formName'] ?? '',
        'pdf_file' => $record['pdfFile'] ?? '',
        'title' => $record['title'],
        'description' => $record['description'] ?? '',
        'status' => $record['status'],
        'created_at' => ebr_db_batch_ts_param($record['createdAt'] ?? null),
        'updated_at' => ebr_db_batch_ts_param($record['updatedAt'] ?? null),
        'completed_at' => ebr_db_batch_ts_nullable_param($record['completedAt'] ?? null),
        'created_by' => $cb,
        'last_entry_id' => $record['lastEntryId'] ?? null,
        'last_entry_filename' => $record['lastEntryFilename'] ?? null,
        'completed_sign_off_by' => $record['completedSignOffBy'] ?? null,
        'completed_sign_off_at' => ebr_db_batch_ts_nullable_param($record['completedSignOffAt'] ?? null),
    ]);
}

function ebr_db_batch_fetch_by_id(string $batchId): ?array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT * FROM ebr_batch_records WHERE id = :id LIMIT 1');
    $st->execute(['id' => $batchId]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    return ebr_db_batch_row_to_api($row);
}

/**
 * @return list<array<string, mixed>>
 */
function ebr_db_batch_list(string $status, ?string $filterByCreator): array
{
    $pdo = ebr_pg_pdo();
    if ($filterByCreator !== null && $filterByCreator !== '') {
        $sql = 'SELECT * FROM ebr_batch_records WHERE status = :status AND created_by IS NOT NULL AND LOWER(TRIM(created_by)) = LOWER(TRIM(:cb)) ORDER BY updated_at DESC NULLS LAST, created_at DESC';
        $st = $pdo->prepare($sql);
        $st->execute(['status' => $status, 'cb' => $filterByCreator]);
    } else {
        $sql = 'SELECT * FROM ebr_batch_records WHERE status = :status ORDER BY updated_at DESC NULLS LAST, created_at DESC';
        $st = $pdo->prepare($sql);
        $st->execute(['status' => $status]);
    }
    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_batch_row_to_api($row);
    }

    return $out;
}

/**
 * Persist a full batch record (API-shaped keys). Row must already exist.
 *
 * @param array<string, mixed> $merged
 */
function ebr_db_batch_save_from_api(array $merged): ?array
{
    $batchId = $merged['id'] ?? '';
    if ($batchId === '' || ebr_db_batch_fetch_by_id($batchId) === null) {
        return null;
    }

    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
UPDATE ebr_batch_records SET
    form_id = :form_id,
    form_name = :form_name,
    pdf_file = :pdf_file,
    title = :title,
    description = :description,
    status = :status,
    created_at = :created_at,
    updated_at = :updated_at,
    completed_at = :completed_at,
    created_by = :created_by,
    last_entry_id = :last_entry_id,
    last_entry_filename = :last_entry_filename,
    completed_sign_off_by = :completed_sign_off_by,
    completed_sign_off_at = :completed_sign_off_at
WHERE id = :id
SQL;
    $st = $pdo->prepare($sql);
    $cb = $merged['createdBy'] ?? null;
    $cb = ($cb !== null && trim((string) $cb) !== '') ? trim((string) $cb) : null;

    $st->execute([
        'id' => $merged['id'],
        'form_id' => $merged['formId'],
        'form_name' => $merged['formName'] ?? '',
        'pdf_file' => $merged['pdfFile'] ?? '',
        'title' => $merged['title'],
        'description' => $merged['description'] ?? '',
        'status' => $merged['status'],
        'created_at' => ebr_db_batch_ts_param($merged['createdAt'] ?? null),
        'updated_at' => ebr_db_batch_ts_param($merged['updatedAt'] ?? null),
        'completed_at' => ebr_db_batch_ts_nullable_param($merged['completedAt'] ?? null),
        'created_by' => $cb,
        'last_entry_id' => $merged['lastEntryId'] ?? null,
        'last_entry_filename' => $merged['lastEntryFilename'] ?? null,
        'completed_sign_off_by' => $merged['completedSignOffBy'] ?? null,
        'completed_sign_off_at' => ebr_db_batch_ts_nullable_param($merged['completedSignOffAt'] ?? null),
    ]);

    return ebr_db_batch_fetch_by_id($batchId);
}

/**
 * Update last entry pointers when saving data (in-progress batches only).
 */
function ebr_db_batch_touch_last_entry(string $batchId, string $entryId, string $filename): bool
{
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
UPDATE ebr_batch_records SET
    updated_at = :u,
    last_entry_id = :eid,
    last_entry_filename = :fn
WHERE id = :id AND status = 'in_progress'
SQL;
    $st = $pdo->prepare($sql);
    $st->execute([
        'u' => date('c'),
        'eid' => $entryId,
        'fn' => $filename,
        'id' => $batchId,
    ]);

    return $st->rowCount() > 0;
}

/**
 * Batches matching title or form name search (for data search UI).
 *
 * @return list<array<string, mixed>>
 */
function ebr_db_batch_rows_for_search(string $needleLower, string $scope): array
{
    $pdo = ebr_pg_pdo();
    $q = $needleLower;
    if ($scope === 'batch_title') {
        $st = $pdo->prepare('SELECT * FROM ebr_batch_records WHERE strpos(LOWER(title), :q) > 0');
        $st->execute(['q' => $q]);
    } elseif ($scope === 'form_name') {
        $st = $pdo->prepare('SELECT * FROM ebr_batch_records WHERE strpos(LOWER(form_name), :q) > 0');
        $st->execute(['q' => $q]);
    } else {
        $st = $pdo->prepare('SELECT * FROM ebr_batch_records WHERE strpos(LOWER(title), :q) > 0 OR strpos(LOWER(form_name), :q2) > 0');
        $st->execute(['q' => $q, 'q2' => $q]);
    }
    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_batch_row_to_api($row);
    }

    return $out;
}
