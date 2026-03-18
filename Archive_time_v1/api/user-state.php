<?php
declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');

// DB location (outside web root)
$DB_PATH = __DIR__ . '/../../../protected/time/time.sqlite';

// Your API key (must match app.js)
$API_KEY = 'IamShiva';

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

// Auth: check X-Api-Key header
if ($API_KEY !== '') {
  $headers = function_exists('getallheaders') ? getallheaders() : [];
  $clientKey =
    $_SERVER['HTTP_X_API_KEY'] ??
    $_SERVER['HTTP_X_APIKEY'] ??
    ($headers['X-Api-Key'] ?? $headers['x-api-key'] ?? '');

  $clientKey = trim((string)$clientKey);

  if (!hash_equals(trim($API_KEY), $clientKey)) {
    respond(401, ['ok' => false, 'error' => 'Unauthorized']);
  }
}

try {
  $pdo = new PDO('sqlite:' . $DB_PATH, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);

  $pdo->exec('PRAGMA journal_mode=WAL;');
  $pdo->exec('PRAGMA synchronous=NORMAL;');

  $pdo->exec('
    CREATE TABLE IF NOT EXISTS user_state (
      username   TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  ');
} catch (Throwable $e) {
  respond(500, ['ok' => false, 'error' => 'DB init failed']);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
  $u = norm_user($_GET['u'] ?? '');
  if ($u === '') respond(400, ['ok' => false, 'error' => 'Missing username']);

  $stmt = $pdo->prepare('SELECT state_json, updated_at FROM user_state WHERE username = :u');
  $stmt->execute([':u' => $u]);
  $row = $stmt->fetch();

  if (!$row) respond(404, ['ok' => false, 'error' => 'Not found']);

  $state = json_decode($row['state_json'], true);
  if (!is_array($state)) $state = [];
  if (!isset($state['updatedAt'])) $state['updatedAt'] = $row['updated_at'];

  respond(200, ['state' => $state]);
}

if ($method === 'POST') {
  $raw = file_get_contents('php://input') ?: '';
  $data = json_decode($raw, true);
  if (!is_array($data)) respond(400, ['ok' => false, 'error' => 'Invalid JSON']);

  $u = norm_user($data['username'] ?? '');
  $state = $data['state'] ?? null;

  if ($u === '' || !is_array($state)) {
    respond(400, ['ok' => false, 'error' => 'username/state required']);
  }

  // Safety caps
  $stateJson = json_encode($state, JSON_UNESCAPED_UNICODE);
  if ($stateJson === false) respond(400, ['ok' => false, 'error' => 'Encode failed']);
  if (strlen($stateJson) > 300000) respond(413, ['ok' => false, 'error' => 'Payload too large']);

  $updatedAt = $state['updatedAt'] ?? gmdate('c');

  $stmt = $pdo->prepare('
    INSERT INTO user_state (username, state_json, updated_at)
    VALUES (:u, :j, :t)
    ON CONFLICT(username) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  ');
  $stmt->execute([':u' => $u, ':j' => $stateJson, ':t' => $updatedAt]);

  respond(200, ['ok' => true]);
}

respond(405, ['ok' => false, 'error' => 'Method not allowed']);