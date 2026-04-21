<?php

declare(strict_types=1);

/**
 * PostgreSQL storage for PDF template binaries (replaces uploads/*.pdf as source of truth).
 */

require_once __DIR__ . '/db.php';

function ebr_db_pdf_template_normalize_filename(string $filename): string
{
    $b = basename(str_replace('\\', '/', $filename));
    if ($b === '' || str_contains($b, '..')) {
        return '';
    }

    return $b;
}

/**
 * @return ?string raw PDF bytes
 */
function ebr_db_pdf_template_fetch_bytes_by_filename(string $filename): ?string
{
    $fn = ebr_db_pdf_template_normalize_filename($filename);
    if ($fn === '' || strtolower(pathinfo($fn, PATHINFO_EXTENSION)) !== 'pdf') {
        return null;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT content FROM ebr_pdf_templates WHERE filename = :f LIMIT 1');
    $st->execute(['f' => $fn]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row || !isset($row['content'])) {
        return null;
    }
    $v = $row['content'];
    if (is_resource($v)) {
        $bin = stream_get_contents($v);
        if ($bin === false) {
            return null;
        }

        return $bin;
    }

    $s = (string) $v;

    return $s !== '' ? $s : null;
}

function ebr_db_pdf_template_exists(string $filename): bool
{
    $fn = ebr_db_pdf_template_normalize_filename($filename);
    if ($fn === '' || strtolower(pathinfo($fn, PATHINFO_EXTENSION)) !== 'pdf') {
        return false;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT 1 FROM ebr_pdf_templates WHERE filename = :f LIMIT 1');
    $st->execute(['f' => $fn]);

    return (bool) $st->fetchColumn();
}

/**
 * Write template bytes to a temp file for Ghostscript / FPDI (caller must unlink).
 */
function ebr_db_pdf_template_materialize_to_temp(string $filename): ?string
{
    $bytes = ebr_db_pdf_template_fetch_bytes_by_filename($filename);
    if (($bytes === null || $bytes === '') && defined('UPLOAD_DIR')) {
        $legacy = UPLOAD_DIR . ebr_db_pdf_template_normalize_filename($filename);
        if (is_readable($legacy) && strtolower(pathinfo($legacy, PATHINFO_EXTENSION)) === 'pdf') {
            $bytes = (string) file_get_contents($legacy);
        }
    }
    if ($bytes === null || $bytes === '') {
        return null;
    }
    $tmp = tempnam(sys_get_temp_dir(), 'ebrtmppdf');
    if ($tmp === false) {
        return null;
    }
    if (file_put_contents($tmp, $bytes) === false) {
        @unlink($tmp);

        return null;
    }

    return $tmp;
}

function ebr_db_pdf_template_unlink_temp(?string $path): void
{
    if ($path === null || $path === '' || !is_file($path)) {
        return;
    }
    $tmp = sys_get_temp_dir();
    if (str_starts_with($path, $tmp)) {
        @unlink($path);
    }
}

/**
 * @param string $binary raw PDF bytes
 */
function ebr_db_pdf_template_insert(string $id, string $filename, string $originalName, string $binary): void
{
    $fn = ebr_db_pdf_template_normalize_filename($filename);
    if ($fn === '') {
        throw new InvalidArgumentException('Invalid template filename');
    }
    $pdo = ebr_pg_pdo();
    // Hex + decode() avoids PDO/pgsql mis-handling of raw BYTEA parameter binding for binary PDFs.
    $sql = <<<'SQL'
INSERT INTO ebr_pdf_templates (id, filename, original_name, content, file_size, uploaded_at)
VALUES (:id, :filename, :original_name, decode(:content_hex, 'hex'), :file_size, NOW())
SQL;
    $st = $pdo->prepare($sql);
    $st->bindValue('id', $id);
    $st->bindValue('filename', $fn);
    $st->bindValue('original_name', $originalName);
    $st->bindValue('content_hex', bin2hex($binary));
    $st->bindValue('file_size', strlen($binary), PDO::PARAM_INT);
    $st->execute();
}

/**
 * @return list<array{name: string, display_name: string, size: int, path: string, uploaded: int}>
 */
function ebr_db_pdf_template_list_for_api(): array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->query(
        'SELECT filename, original_name, file_size, EXTRACT(EPOCH FROM uploaded_at)::bigint AS uploaded
         FROM ebr_pdf_templates ORDER BY uploaded_at DESC'
    );
    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $name = (string) ($row['filename'] ?? '');
        if ($name === '') {
            continue;
        }
        $on = trim((string) ($row['original_name'] ?? ''));
        $out[] = [
            'name' => $name,
            'display_name' => $on !== '' ? pathinfo($on, PATHINFO_FILENAME) : pathinfo($name, PATHINFO_FILENAME),
            'size' => (int) ($row['file_size'] ?? 0),
            'path' => '/uploads/' . rawurlencode($name),
            'uploaded' => (int) ($row['uploaded'] ?? 0),
        ];
    }

    return $out;
}
