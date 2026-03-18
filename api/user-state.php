<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

$DB_PATH = __DIR__ . '/../../../protected/time/time.sqlite';
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function respond(int $code, array $payload): void {
  http_response_code($code);
  echo json_encode($payload);
  exit;
}

function norm_user($u): string {
  $u = trim((string)$u);
  if ($u === '' || strlen($u) > 128) return '';
  return $u;
}

function get_headers_lower(): array {
  $h = function_exists('getallheaders') ? getallheaders() : [];
  $out = [];
  foreach ($h as $k => $v) $out[strtolower((string)$k)] = (string)$v;
  return $out;
}

$headersLower = get_headers_lower();

$userPin = trim((string)(
  $_SERVER['HTTP_X_USER_PIN'] ??
  ($headersLower['x-user-pin'] ?? '')
));

try {
  $pdo = new PDO('sqlite:' . $DB_PATH, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  $pdo->exec('PRAGMA journal_mode=WAL;');
  $pdo->exec('PRAGMA synchronous=NORMAL;');

  $pdo->exec('
    CREATE TABLE IF NOT EXISTS user_state (
      username TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  ');

  $pdo->exec('
    CREATE TABLE IF NOT EXISTS user_auth (
      username TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL,
      hint TEXT NOT NULL
    );
  ');

  $pdo->exec('
    CREATE TABLE IF NOT EXISTS pin_attempts (
      username TEXT NOT NULL,
      ip TEXT NOT NULL,
      fail_count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (username, ip)
    );
  ');
} catch (Throwable $e) {
  respond(500, ['ok' => false, 'error' => 'DB init failed']);
}

function get_hint(PDO $pdo, string $u): ?string {
  $st = $pdo->prepare('SELECT hint FROM user_auth WHERE username = :u');
  $st->execute([':u' => $u]);
  $r = $st->fetch();
  return $r ? (string)$r['hint'] : null;
}

function auth_row(PDO $pdo, string $u): ?array {
  $st = $pdo->prepare('SELECT pin_hash, hint FROM user_auth WHERE username = :u');
  $st->execute([':u' => $u]);
  $r = $st->fetch();
  return $r ?: null;
}

function state_exists(PDO $pdo, string $u): bool {
  $st = $pdo->prepare('SELECT 1 FROM user_state WHERE username = :u');
  $st->execute([':u' => $u]);
  return (bool)$st->fetch();
}

function client_ip(): string {
  $ip = trim((string)($_SERVER['REMOTE_ADDR'] ?? 'unknown'));
  return $ip !== '' ? $ip : 'unknown';
}

function rate_limit_check(PDO $pdo, string $u, string $ip): void {
  $now = time();
  $st = $pdo->prepare('SELECT blocked_until FROM pin_attempts WHERE username = :u AND ip = :ip');
  $st->execute([':u' => $u, ':ip' => $ip]);
  $row = $st->fetch();

  if (!$row) return;

  $blockedUntil = (int)($row['blocked_until'] ?? 0);
  if ($blockedUntil > $now) {
    respond(429, [
      'ok' => false,
      'error' => 'TOO_MANY_ATTEMPTS',
      'retryAfterSec' => $blockedUntil - $now,
    ]);
  }
}

function rate_limit_fail(PDO $pdo, string $u, string $ip): void {
  $windowSec = 300;
  $maxFailures = 8;
  $blockSec = 600;
  $now = time();

  $st = $pdo->prepare('SELECT fail_count, window_start FROM pin_attempts WHERE username = :u AND ip = :ip');
  $st->execute([':u' => $u, ':ip' => $ip]);
  $row = $st->fetch();

  if (!$row) {
    $ins = $pdo->prepare('
      INSERT INTO pin_attempts (username, ip, fail_count, window_start, blocked_until)
      VALUES (:u, :ip, 1, :ws, 0)
    ');
    $ins->execute([':u' => $u, ':ip' => $ip, ':ws' => $now]);
    return;
  }

  $windowStart = (int)$row['window_start'];
  $failCount = (int)$row['fail_count'];

  if (($now - $windowStart) > $windowSec) {
    $failCount = 1;
    $windowStart = $now;
  } else {
    $failCount++;
  }

  $blockedUntil = $failCount >= $maxFailures ? ($now + $blockSec) : 0;

  $upd = $pdo->prepare('
    UPDATE pin_attempts
    SET fail_count = :fc, window_start = :ws, blocked_until = :bu
    WHERE username = :u AND ip = :ip
  ');
  $upd->execute([
    ':fc' => $failCount,
    ':ws' => $windowStart,
    ':bu' => $blockedUntil,
    ':u' => $u,
    ':ip' => $ip,
  ]);
}

function rate_limit_success(PDO $pdo, string $u, string $ip): void {
  $st = $pdo->prepare('DELETE FROM pin_attempts WHERE username = :u AND ip = :ip');
  $st->execute([':u' => $u, ':ip' => $ip]);
}

function require_pin_setup_or_verify(PDO $pdo, string $u, string $pin, string $ip): void {
  $auth = auth_row($pdo, $u);
  $hasState = state_exists($pdo, $u);

  // If we have any record for that username, we require a PIN to exist.
  if ($hasState && !$auth) {
    respond(401, ['ok' => false, 'error' => 'PIN_SETUP_REQUIRED', 'hint' => 'Set a PIN for this username']);
  }

  if (!$auth) {
    // No state and no auth => username is new; allow first setup on POST (with pin), but GET should not leak anything
    // We'll treat GET as "no server copy"
    return;
  }

  $hash = (string)$auth['pin_hash'];
  $hint = (string)$auth['hint'];

  rate_limit_check($pdo, $u, $ip);

  if ($pin === '' || !password_verify($pin, $hash)) {
    rate_limit_fail($pdo, $u, $ip);
    respond(401, ['ok' => false, 'error' => 'PIN_REQUIRED', 'hint' => $hint]);
  }

  rate_limit_success($pdo, $u, $ip);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
  $u = norm_user($_GET['u'] ?? '');
  if ($u === '') respond(400, ['ok' => false, 'error' => 'Missing username']);
  $ip = client_ip();

  // If state exists or auth exists, enforce PIN
  require_pin_setup_or_verify($pdo, $u, $userPin, $ip);

  $stmt = $pdo->prepare('SELECT state_json, updated_at FROM user_state WHERE username = :u');
  $stmt->execute([':u' => $u]);
  $row = $stmt->fetch();

  if (!$row) {
    // If no state exists, return 404 (no leak)
    respond(404, ['ok' => false, 'error' => 'Not found']);
  }

  $state = json_decode((string)$row['state_json'], true);
  if (!is_array($state)) $state = [];
  if (!isset($state['updatedAt'])) $state['updatedAt'] = (string)$row['updated_at'];

  $hint = get_hint($pdo, $u);
  $resp = ['state' => $state];
  if ($hint !== null) $resp['hint'] = $hint;

  respond(200, $resp);
}

if ($method === 'POST') {
  $raw = file_get_contents('php://input') ?: '';
  $data = json_decode($raw, true);
  if (!is_array($data)) respond(400, ['ok' => false, 'error' => 'Invalid JSON']);

  $u = norm_user($data['username'] ?? '');
  $state = $data['state'] ?? null;

  $pinBody = trim((string)($data['pin'] ?? ''));
  $pin = $userPin !== '' ? $userPin : $pinBody;
  $pinHint = trim((string)($data['pinHint'] ?? ''));

  if ($u === '' || !is_array($state)) respond(400, ['ok' => false, 'error' => 'username/state required']);

  $auth = auth_row($pdo, $u);
  $ip = client_ip();

  if ($auth) {
    // Verify PIN for existing user
    require_pin_setup_or_verify($pdo, $u, $pin, $ip);
  } else {
    // No auth set yet. If there's already state or user wants to create state, we MUST set a PIN now.
    if ($pin === '') {
      respond(401, ['ok' => false, 'error' => 'PIN_SETUP_REQUIRED', 'hint' => 'Set a PIN for this username']);
    }
    if ($pinHint === '') {
      respond(400, ['ok' => false, 'error' => 'PIN_HINT_REQUIRED', 'hint' => 'Add a PIN hint for this username']);
    }
    $hintToStore = $pinHint;
    $hash = password_hash($pin, PASSWORD_DEFAULT);

    $st = $pdo->prepare('INSERT INTO user_auth (username, pin_hash, hint) VALUES (:u,:h,:t)');
    $st->execute([':u' => $u, ':h' => $hash, ':t' => $hintToStore]);
  }

  $stateJson = json_encode($state, JSON_UNESCAPED_UNICODE);
  if ($stateJson === false) respond(400, ['ok' => false, 'error' => 'Encode failed']);
  if (strlen($stateJson) > 350000) respond(413, ['ok' => false, 'error' => 'Payload too large']);

  $updatedAt = gmdate('c');

  $stmt = $pdo->prepare('
    INSERT INTO user_state (username, state_json, updated_at)
    VALUES (:u, :j, :t)
    ON CONFLICT(username) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  ');
  $stmt->execute([':u' => $u, ':j' => $stateJson, ':t' => (string)$updatedAt]);

  $hint = get_hint($pdo, $u);
  $resp = ['ok' => true];
  if ($hint !== null) $resp['hint'] = $hint;

  respond(200, $resp);
}

respond(405, ['ok' => false, 'error' => 'Method not allowed']);
