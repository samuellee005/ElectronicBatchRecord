<?php

declare(strict_types=1);

/**
 * Per-user UI preferences (replaces most browser localStorage for shared installs).
 */

require_once __DIR__ . '/db.php';

function ebr_db_user_prefs_normalize_key(string $userKey): string
{
    $s = trim($userKey);
    if ($s === '') {
        return '';
    }
    if (strlen($s) > 512) {
        $s = substr($s, 0, 512);
    }

    return $s;
}

/**
 * @return array<string, mixed>
 */
function ebr_db_user_preferences_fetch(string $userKey): array
{
    $k = ebr_db_user_prefs_normalize_key($userKey);
    if ($k === '') {
        return [];
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT prefs FROM ebr_user_preferences WHERE user_key = :k LIMIT 1');
    $st->execute(['k' => $k]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row || !array_key_exists('prefs', $row)) {
        return [];
    }
    $p = $row['prefs'];
    if (is_string($p)) {
        $d = json_decode($p, true);

        return is_array($d) ? $d : [];
    }
    if (is_array($p)) {
        return $p;
    }

    return [];
}

/**
 * @param array<string, mixed> $prefs
 */
function ebr_db_user_preferences_save(string $userKey, array $prefs): void
{
    $flags = JSON_UNESCAPED_UNICODE;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $json = json_encode($prefs, $flags);
    if ($json === false) {
        throw new RuntimeException('prefs JSON encode failed');
    }
    ebr_db_user_preferences_save_json($userKey, $json);
}

/**
 * Persist prefs JSON (already UTF-8 encoded). Use for decoded bodies where empty objects must stay objects.
 */
function ebr_db_user_preferences_save_json(string $userKey, string $json): void
{
    $k = ebr_db_user_prefs_normalize_key($userKey);
    if ($k === '') {
        throw new InvalidArgumentException('userKey required');
    }
    if (strlen($json) > 524288) {
        throw new InvalidArgumentException('prefs payload too large');
    }
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
INSERT INTO ebr_user_preferences (user_key, prefs, updated_at)
VALUES (:k, CAST(:p AS jsonb), NOW())
ON CONFLICT (user_key) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()
SQL;
    $st = $pdo->prepare($sql);
    $st->execute(['k' => $k, 'p' => $json]);
}
