<?php

declare(strict_types=1);

/**
 * Server-side validation of per-entry attribution.
 *
 * The browser locks fields locally and only posts them when the operator saves, so every
 * "this was recorded by X" arrives as a claim. Each claim names the presence window it was
 * made under; this checks that the window really was that person's own verified window on
 * this batch, and that the entry timestamp falls inside it. Claims that do not check out are
 * rejected rather than stored — an attribution nobody verified is worse than none.
 *
 * Shape of a validated claim (as stored in ebr_data_entries.data):
 *   recordedBy: { userId, username, displayName, presenceId, at, verified: true }
 *
 * Legacy entries carry recordedBy as a bare display-name string; those pass through
 * untouched so historical records keep reading correctly.
 */

require_once __DIR__ . '/db-batch-collab.php';

/**
 * Validate one attribution claim against the presence ledger.
 *
 * @param mixed $claim
 * @return array{0: mixed, 1: string|null} [normalized claim, error message or null]
 */
function ebr_attribution_check($claim, string $batchId, bool $verificationAvailable, string $fieldLabel): array
{
    // Absent, or a legacy display-name string: nothing to verify.
    if ($claim === null || $claim === '' || is_string($claim)) {
        return [$claim, null];
    }
    if (!is_array($claim)) {
        return [null, null];
    }

    $userId = (int) ($claim['userId'] ?? 0);
    $presenceId = trim((string) ($claim['presenceId'] ?? ''));
    $at = trim((string) ($claim['at'] ?? ''));

    $normalized = [
        'userId' => $userId,
        'username' => trim((string) ($claim['username'] ?? '')),
        'displayName' => trim((string) ($claim['displayName'] ?? '')),
        'presenceId' => $presenceId,
        'at' => $at,
    ];

    if (!$verificationAvailable) {
        // Password checking is off on this deployment (dev). Keep the name for continuity but
        // never claim it was verified.
        $normalized['verified'] = false;

        return [$normalized, null];
    }

    if ($userId <= 0 || $presenceId === '' || $at === '') {
        return [null, $fieldLabel . ': attribution is missing its verification reference.'];
    }

    try {
        $ok = ebr_db_presence_covers($presenceId, $batchId, $userId, $at);
    } catch (Throwable $e) {
        error_log('ebr entry-attribution: ' . $e->getMessage());

        return [null, $fieldLabel . ': could not check the verification record.'];
    }

    if (!$ok) {
        return [
            null,
            $fieldLabel . ': recorded by ' . ($normalized['displayName'] ?: 'an unknown user')
            . ' outside a valid Live Collab verification. Re-verify and enter it again.',
        ];
    }

    $normalized['verified'] = true;

    return [$normalized, null];
}

/**
 * Walk a posted data payload, validating every attribution it carries.
 *
 * @param array<string, mixed> $data           formData snapshot keyed by field id
 * @param array<string, string> $fieldLabels   field id → human label, for error messages
 * @return array{data: array<string, mixed>, errors: list<string>}
 */
function ebr_attribution_validate_payload(
    array $data,
    string $batchId,
    bool $verificationAvailable,
    array $fieldLabels = []
): array {
    $errors = [];

    foreach ($data as $fieldId => $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $label = $fieldLabels[$fieldId] ?? (string) $fieldId;

        if (array_key_exists('recordedBy', $entry)) {
            [$claim, $err] = ebr_attribution_check($entry['recordedBy'], $batchId, $verificationAvailable, $label);
            if ($err !== null) {
                $errors[] = $err;
            } elseif ($claim === null) {
                unset($entry['recordedBy']);
            } else {
                $entry['recordedBy'] = $claim;
            }
        }

        if (isset($entry['corrections']) && is_array($entry['corrections'])) {
            foreach ($entry['corrections'] as $i => $correction) {
                if (!is_array($correction) || !array_key_exists('by', $correction)) {
                    continue;
                }
                [$claim, $err] = ebr_attribution_check(
                    $correction['by'],
                    $batchId,
                    $verificationAvailable,
                    $label . ' (correction ' . ((int) $i + 1) . ')'
                );
                if ($err !== null) {
                    $errors[] = $err;
                } elseif ($claim === null) {
                    unset($entry['corrections'][$i]['by']);
                } else {
                    $entry['corrections'][$i]['by'] = $claim;
                }
            }
        }

        $data[$fieldId] = $entry;
    }

    return ['data' => $data, 'errors' => $errors];
}
