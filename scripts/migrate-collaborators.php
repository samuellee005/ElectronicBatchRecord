<?php

declare(strict_types=1);

/**
 * Migrate legacy primary/secondary collaborator data into ebr_batch_collaborators.
 *
 * Before: each batch stored its collaborators inside the data entry, as a `collaborator`
 * field holding { primaryUserId, secondaryUserId } pointing at ebr_active_users rows.
 * After: collaborators are rows in ebr_batch_collaborators keyed to real db_user accounts.
 *
 * Also backfills ebr_batch_records.created_by_user_id by matching the stored created_by
 * display name against db_user.
 *
 * Usage (dry run by default — prints what it would do and changes nothing):
 *   php scripts/migrate-collaborators.php
 *   php scripts/migrate-collaborators.php --apply
 *
 * Names that cannot be resolved to exactly one db_user account are listed at the end for
 * manual cleanup; nothing is guessed.
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';
require_once __DIR__ . '/../includes/db-batch-records.php';
require_once __DIR__ . '/../includes/db-data-entries.php';
require_once __DIR__ . '/../includes/db-forms.php';
require_once __DIR__ . '/../includes/db-batch-collab.php';
require_once __DIR__ . '/../includes/db-db-user.php';

$apply = in_array('--apply', $argv ?? [], true);
$pdo = ebr_pg_pdo();

echo ($apply ? 'APPLY' : 'DRY RUN') . ' — database ' . ebr_resolve_pg_database() . PHP_EOL;
echo str_repeat('-', 72) . PHP_EOL;

/**
 * Resolve a display name to exactly one db_user account.
 *
 * @return array{0: array<string,mixed>|null, 1: string} [row, reason when null]
 */
function mc_resolve_user(string $displayName): array
{
    $name = trim($displayName);
    if ($name === '') {
        return [null, 'empty name'];
    }

    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        "SELECT db_user_id, username, password, first_name, last_name, email, disabled
           FROM db_user
          WHERE LOWER(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) = LOWER(TRIM(:n))
             OR LOWER(TRIM(username)) = LOWER(TRIM(:n))"
    );
    $st->execute(['n' => $name]);
    $rows = $st->fetchAll(PDO::FETCH_ASSOC);

    if (count($rows) === 1) {
        return [$rows[0], ''];
    }
    if ($rows === []) {
        return [null, 'no db_user match'];
    }

    return [null, 'ambiguous — ' . count($rows) . ' db_user matches'];
}

// Old roster: ebr_active_users id → display name (the ids legacy collaborator fields point at).
$roster = [];
foreach ($pdo->query('SELECT id, display_name FROM ebr_active_users')->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $roster[(string) $r['id']] = (string) $r['display_name'];
}

$unresolved = [];
$statBatches = 0;
$statCollab = 0;
$statCreator = 0;

$batches = $pdo->query('SELECT * FROM ebr_batch_records ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);

foreach ($batches as $row) {
    $batch = ebr_db_batch_row_to_api($row);
    $batchId = (string) $batch['id'];

    // ── created_by_user_id backfill ─────────────────────────────────────────
    // The creator also joins the roster (as create-batch-record.php does for new batches),
    // otherwise they keep write access but cannot be picked as the recorder in Live Collab.
    if (trim((string) $batch['createdBy']) !== '') {
        $creatorId = (int) ($batch['createdByUserId'] ?? 0);
        $creator = $creatorId > 0 ? ebr_db_user_fetch_by_id($creatorId) : null;
        $why = '';
        if ($creator === null) {
            [$creator, $why] = mc_resolve_user((string) $batch['createdBy']);
        }

        if ($creator !== null) {
            if ($creatorId <= 0) {
                echo "{$batchId}: creator '{$batch['createdBy']}' → db_user #{$creator['db_user_id']}" . PHP_EOL;
                if ($apply) {
                    $up = $pdo->prepare('UPDATE ebr_batch_records SET created_by_user_id = :u WHERE id = :i');
                    $up->execute(['u' => (int) $creator['db_user_id'], 'i' => $batchId]);
                }
                $statCreator++;
            }
            if (!ebr_db_collab_is_member($batchId, (int) $creator['db_user_id'])) {
                echo "{$batchId}: creator '{$batch['createdBy']}' joins the collaborator roster" . PHP_EOL;
                if ($apply) {
                    ebr_db_collab_add($batchId, $creator, ['id' => 0, 'username' => 'migration']);
                }
                $statCollab++;
            }
        } else {
            $unresolved[] = "{$batchId}: creator '{$batch['createdBy']}' — {$why}";
        }
    }

    // ── legacy primary/secondary → collaborator rows ────────────────────────
    try {
        $form = ebr_db_forms_fetch_by_id((string) $batch['formId']);
    } catch (Throwable $e) {
        $form = null;
    }
    if ($form === null) {
        continue;
    }

    $collabFieldIds = [];
    foreach (($form['fields'] ?? []) as $f) {
        if (is_array($f) && ($f['type'] ?? '') === 'collaborator' && isset($f['id'])) {
            $collabFieldIds[] = (string) $f['id'];
        }
    }
    if ($collabFieldIds === []) {
        continue;
    }

    [$formData] = ebr_db_entry_resolve_for_batch($batch, $batchId);
    if (!is_array($formData) || $formData === []) {
        continue;
    }

    $legacyNames = [];
    foreach ($collabFieldIds as $fid) {
        $entry = $formData[$fid] ?? null;
        if (!is_array($entry)) {
            continue;
        }
        // Field entries are { v, enteredAt, ... }; the value may also sit at the top level.
        $value = (is_array($entry['v'] ?? null)) ? $entry['v'] : $entry;
        foreach (['primary', 'secondary'] as $slot) {
            $uid = trim((string) ($value[$slot . 'UserId'] ?? ''));
            $dn = trim((string) ($value[$slot . 'DisplayName'] ?? ''));
            if ($dn === '' && $uid !== '') {
                $dn = $roster[$uid] ?? '';
            }
            if ($dn !== '') {
                $legacyNames[$dn] = true;
            }
        }
    }

    if ($legacyNames === []) {
        continue;
    }

    $statBatches++;
    foreach (array_keys($legacyNames) as $name) {
        [$userRow, $why] = mc_resolve_user($name);
        if ($userRow === null) {
            $unresolved[] = "{$batchId}: collaborator '{$name}' — {$why}";
            continue;
        }
        if (ebr_db_collab_is_member($batchId, (int) $userRow['db_user_id'])) {
            continue;
        }
        echo "{$batchId}: collaborator '{$name}' → db_user #{$userRow['db_user_id']}" . PHP_EOL;
        if ($apply) {
            ebr_db_collab_add($batchId, $userRow, ['id' => 0, 'username' => 'migration']);
        }
        $statCollab++;
    }
}

echo str_repeat('-', 72) . PHP_EOL;
echo "Batches with legacy collaborators: {$statBatches}" . PHP_EOL;
echo "Collaborator rows " . ($apply ? 'written' : 'to write') . ": {$statCollab}" . PHP_EOL;
echo "Creator ids " . ($apply ? 'backfilled' : 'to backfill') . ": {$statCreator}" . PHP_EOL;

if ($unresolved !== []) {
    echo PHP_EOL . 'NEEDS MANUAL CLEANUP (' . count($unresolved) . '):' . PHP_EOL;
    foreach ($unresolved as $u) {
        echo '  ' . $u . PHP_EOL;
    }
    echo PHP_EOL . 'These names could not be matched to exactly one db_user account. Add or correct'
        . PHP_EOL . 'the accounts, then re-run. Nothing was guessed.' . PHP_EOL;
}

if (!$apply) {
    echo PHP_EOL . 'Dry run — nothing was written. Re-run with --apply to commit.' . PHP_EOL;
}
