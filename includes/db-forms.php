<?php

declare(strict_types=1);

/**
 * PostgreSQL persistence for ebr_forms (replaces JSON files in forms/).
 */

require_once __DIR__ . '/db.php';

/**
 * JSON for jsonb columns; never returns false (UTF-8 safe for PostgreSQL).
 *
 * @param mixed $data
 */
function ebr_db_forms_json_enc($data): string
{
    $flags = JSON_UNESCAPED_UNICODE;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $j = json_encode($data, $flags);
    if ($j === false) {
        throw new RuntimeException('JSON encode failed for form payload');
    }

    return $j;
}

/** PostgreSQL boolean text for PDO (PHP false must not become ""). */
function ebr_db_pg_bool_param(bool $v): string
{
    return $v ? 't' : 'f';
}

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function ebr_db_form_row_to_api(array $row): array
{
    $json = static function ($key) use ($row) {
        $v = $row[$key] ?? '[]';
        if (is_array($v)) {
            return $v;
        }
        if (is_string($v)) {
            $d = json_decode($v, true);

            return is_array($d) ? $d : [];
        }

        return [];
    };

    return [
        'id' => $row['id'],
        'name' => $row['name'],
        'description' => $row['description'] ?? '',
        'pdfFile' => $row['pdf_file'],
        'fields' => $json('fields'),
        'version' => round((float) ($row['version'] ?? 1), 1),
        'isLatest' => !empty($row['is_latest']),
        'sourceFormIds' => $json('source_form_ids'),
        'isCombined' => !empty($row['is_combined']),
        'auditTrail' => $json('audit_trail'),
        'createdAt' => $row['created_at'] ?? '',
        'updatedAt' => $row['updated_at'] ?? '',
        'createdBy' => $row['created_by'],
        'updatedBy' => $row['updated_by'],
        'storageFilename' => $row['storage_filename'] ?? null,
    ];
}

/**
 * @return list<array<string, mixed>>
 */
function ebr_db_forms_all_api(): array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->query('SELECT * FROM ebr_forms');
    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_form_row_to_api($row);
    }

    return $out;
}

function ebr_db_forms_fetch_by_id(string $id): ?array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT * FROM ebr_forms WHERE id = :id LIMIT 1');
    $st->execute(['id' => $id]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    return ebr_db_form_row_to_api($row);
}

/**
 * @param array<string, mixed> $form API-shaped form config
 */
function ebr_db_forms_insert_api(array $form, ?string $storageFilename): void
{
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
INSERT INTO ebr_forms (
    id, name, description, pdf_file, fields, version, is_latest,
    source_form_ids, is_combined, audit_trail,
    created_at, updated_at, created_by, updated_by, storage_filename
) VALUES (
    :id, :name, :description, :pdf_file, CAST(:fields AS jsonb), :version, :is_latest,
    CAST(:source_form_ids AS jsonb), :is_combined, CAST(:audit_trail AS jsonb),
    :created_at, :updated_at, :created_by, :updated_by, :storage_filename
)
SQL;
    $st = $pdo->prepare($sql);
    $st->execute([
        'id' => $form['id'],
        'name' => $form['name'],
        'description' => $form['description'] ?? '',
        'pdf_file' => $form['pdfFile'] ?? '',
        'fields' => ebr_db_forms_json_enc($form['fields'] ?? []),
        'version' => $form['version'],
        'is_latest' => ebr_db_pg_bool_param(!empty($form['isLatest'])),
        'source_form_ids' => ebr_db_forms_json_enc($form['sourceFormIds'] ?? []),
        'is_combined' => ebr_db_pg_bool_param(!empty($form['isCombined'])),
        'audit_trail' => ebr_db_forms_json_enc($form['auditTrail'] ?? []),
        'created_at' => $form['createdAt'],
        'updated_at' => $form['updatedAt'],
        'created_by' => $form['createdBy'] ?? null,
        'updated_by' => $form['updatedBy'] ?? null,
        'storage_filename' => $storageFilename,
    ]);
}

/**
 * Full replace of row by id (same shape as insert).
 *
 * @param array<string, mixed> $form
 */
function ebr_db_forms_update_api(array $form, ?string $storageFilename): void
{
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
UPDATE ebr_forms SET
    name = :name,
    description = :description,
    pdf_file = :pdf_file,
    fields = CAST(:fields AS jsonb),
    version = :version,
    is_latest = :is_latest,
    source_form_ids = CAST(:source_form_ids AS jsonb),
    is_combined = :is_combined,
    audit_trail = CAST(:audit_trail AS jsonb),
    created_at = :created_at,
    updated_at = :updated_at,
    created_by = :created_by,
    updated_by = :updated_by,
    storage_filename = :storage_filename
WHERE id = :id
SQL;
    $st = $pdo->prepare($sql);
    $st->execute([
        'id' => $form['id'],
        'name' => $form['name'],
        'description' => $form['description'] ?? '',
        'pdf_file' => $form['pdfFile'] ?? '',
        'fields' => ebr_db_forms_json_enc($form['fields'] ?? []),
        'version' => $form['version'],
        'is_latest' => ebr_db_pg_bool_param(!empty($form['isLatest'])),
        'source_form_ids' => ebr_db_forms_json_enc($form['sourceFormIds'] ?? []),
        'is_combined' => ebr_db_pg_bool_param(!empty($form['isCombined'])),
        'audit_trail' => ebr_db_forms_json_enc($form['auditTrail'] ?? []),
        'created_at' => $form['createdAt'],
        'updated_at' => $form['updatedAt'],
        'created_by' => $form['createdBy'] ?? null,
        'updated_by' => $form['updatedBy'] ?? null,
        'storage_filename' => $storageFilename,
    ]);
}

function ebr_db_forms_mark_not_latest_same_name_pdf(string $name, string $pdfFile, ?string $exceptId): void
{
    $pdo = ebr_pg_pdo();
    if ($exceptId !== null && $exceptId !== '') {
        $st = $pdo->prepare('UPDATE ebr_forms SET is_latest = FALSE WHERE name = :n AND pdf_file = :p AND id <> :exc');
        $st->execute(['n' => $name, 'p' => $pdfFile, 'exc' => $exceptId]);
    } else {
        $st = $pdo->prepare('UPDATE ebr_forms SET is_latest = FALSE WHERE name = :n AND pdf_file = :p');
        $st->execute(['n' => $name, 'p' => $pdfFile]);
    }
}
