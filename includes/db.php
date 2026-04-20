<?php
/**
 * PostgreSQL connection settings and database name resolution.
 *
 * Database selection:
 *   - Arcturus deployment → database db4 (override with EBR_PG_DB_ARCTURUS)
 *   - Any other context → database dev (override with EBR_PG_DB_DEFAULT)
 *
 * Arcturus detection (any one is enough; evaluated after EBR_PG_DATABASE override):
 *   1. EBR_DEPLOYMENT=arcturus
 *   2. EBR_ARCTURUS_APP_IPS — comma-separated list; any candidate from ebr_app_ip_candidates()
 *      must match (typically SERVER_ADDR or EBR_APP_SOURCE_IP).
 *   3. EBR_ARCTURUS_HTTP_HOSTS — comma-separated hostnames; HTTP Host must match
 *      (e.g. arcturus.discoverybase.net behind Apache).
 *
 * Credentials (set when ready):
 *   EBR_PG_HOST, EBR_PG_PORT (default 5432), EBR_PG_USER, EBR_PG_PASSWORD
 *
 * Optional override for the resolved database name:
 *   EBR_PG_DATABASE
 */

declare(strict_types=1);

/**
 * Candidate IPs for "this application" when matching EBR_ARCTURUS_APP_IPS.
 * SERVER_ADDR is the bound address of the PHP server. EBR_APP_SOURCE_IP can be
 * set in the environment (e.g. Docker/host) when SERVER_ADDR is not what Postgres sees.
 *
 * @return list<string>
 */
function ebr_app_ip_candidates(): array
{
    $out = [];
    $serverAddr = $_SERVER['SERVER_ADDR'] ?? '';
    if (is_string($serverAddr) && $serverAddr !== '') {
        $out[] = $serverAddr;
    }
    $explicit = getenv('EBR_APP_SOURCE_IP');
    if ($explicit !== false && $explicit !== '') {
        $out[] = $explicit;
    }
    return array_values(array_unique($out));
}

function ebr_http_host_only(): string
{
    $h = $_SERVER['HTTP_HOST'] ?? '';
    if (!is_string($h) || $h === '') {
        return '';
    }
    if ($h[0] === '[') {
        $end = strpos($h, ']');
        return $end !== false ? strtolower(substr($h, 0, $end + 1)) : strtolower($h);
    }
    $colon = strpos($h, ':');
    return strtolower($colon === false ? $h : substr($h, 0, $colon));
}

/**
 * @param string $csv Comma-separated values from getenv
 * @return list<string>
 */
function ebr_trim_csv(string $csv): array
{
    return array_values(array_filter(array_map('trim', explode(',', $csv))));
}

function ebr_is_arcturus_deployment(): bool
{
    $deploy = getenv('EBR_DEPLOYMENT');
    if ($deploy !== false && strtolower(trim($deploy)) === 'arcturus') {
        return true;
    }

    $arcturusIpsEnv = getenv('EBR_ARCTURUS_APP_IPS');
    if ($arcturusIpsEnv !== false && $arcturusIpsEnv !== '') {
        $want = ebr_trim_csv($arcturusIpsEnv);
        if ($want !== []) {
            foreach (ebr_app_ip_candidates() as $ip) {
                if (in_array($ip, $want, true)) {
                    return true;
                }
            }
        }
    }

    $hostsEnv = getenv('EBR_ARCTURUS_HTTP_HOSTS');
    if ($hostsEnv !== false && $hostsEnv !== '') {
        $allowed = array_map('strtolower', ebr_trim_csv($hostsEnv));
        if ($allowed !== []) {
            $host = ebr_http_host_only();
            if ($host !== '' && in_array($host, $allowed, true)) {
                return true;
            }
        }
    }

    return false;
}

function ebr_resolve_pg_database(): string
{
    $override = getenv('EBR_PG_DATABASE');
    if ($override !== false && $override !== '') {
        return $override;
    }

    if (ebr_is_arcturus_deployment()) {
        $name = getenv('EBR_PG_DB_ARCTURUS');
        return ($name !== false && $name !== '') ? $name : 'db4';
    }

    $name = getenv('EBR_PG_DB_DEFAULT');
    return ($name !== false && $name !== '') ? $name : 'dev';
}

/**
 * Connection parameters for PDO (pgsql). Password may be empty until configured.
 *
 * @return array{host:string,port:int,dbname:string,user:string,password:string}
 */
function ebr_pg_connection_params(): array
{
    $host = getenv('EBR_PG_HOST');
    $host = ($host !== false && $host !== '') ? $host : '';

    $portStr = getenv('EBR_PG_PORT');
    $port = ($portStr !== false && $portStr !== '') ? (int) $portStr : 5432;
    if ($port < 1 || $port > 65535) {
        $port = 5432;
    }

    $user = getenv('EBR_PG_USER');
    $user = ($user !== false && $user !== '') ? $user : '';

    $password = getenv('EBR_PG_PASSWORD');
    if ($password === false) {
        $password = '';
    }

    return [
        'host' => $host,
        'port' => $port,
        'dbname' => ebr_resolve_pg_database(),
        'user' => $user,
        'password' => $password,
    ];
}

/**
 * Shared PDO instance for PostgreSQL (lazy).
 */
function ebr_pg_pdo(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $p = ebr_pg_connection_params();
    if ($p['host'] === '' || $p['user'] === '') {
        throw new RuntimeException(
            'PostgreSQL is not configured: set EBR_PG_HOST and EBR_PG_USER (and EBR_PG_PASSWORD when required).'
        );
    }

    $dsn = sprintf(
        'pgsql:host=%s;port=%d;dbname=%s',
        $p['host'],
        $p['port'],
        $p['dbname']
    );

    $pdo = new PDO($dsn, $p['user'], $p['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);

    return $pdo;
}
