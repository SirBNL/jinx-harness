<?php
// ═══════════════════════════════════════════════════════════════════════════
//  Jinx Harness — keepalive watchdog (cron, every 1–5 minutes)
//
//  Truth = the daemon itself: GET http://127.0.0.1:<port>/health
//  1) alive?    → poll-mode zombie check (process up, polling dead) → reboot
//  2) dead?     → hit the public gateway URL once (it boots the daemon)
//
//  Setup (cPanel → Cron Jobs → every 5 minutes):
//      php /home/USERNAME/public_html/jinx-harness/keepalive.php
//  Or from any external cron:
//      curl -s https://your-site/jinx-harness/ >/dev/null
// ═══════════════════════════════════════════════════════════════════════════

// optional hard overrides if auto-detection fails (uncomment + edit):
// $OVERRIDE_HOST = 'your-site.com';     // e.g. fata.cam
// $OVERRIDE_PATH = '/jinx-harness';       // folder of index.cgi

$BASE = dirname(__DIR__);
$PORT = (int) @trim(@file_get_contents($BASE . '/portable/data/port.txt'));
if ($PORT < 1024) $PORT = 41888;

// web base path of the install (needed because the daemon serves routes
// under PORTABLE_BASE_PATH in CGI mode)
function web_base() {
  global $BASE, $OVERRIDE_PATH;
  if (isset($OVERRIDE_PATH)) return rtrim($OVERRIDE_PATH, '/');
  $env = @parse_ini_file($BASE . '/portable/.env');
  if (!empty($env['PORTABLE_BASE_PATH'])) return rtrim($env['PORTABLE_BASE_PATH'], '/');
  $path = str_replace(DIRECTORY_SEPARATOR, '/', __DIR__); // …/public_html/jinx-harness
  if (($i = strpos($path, 'public_html')) !== false) return '/' . trim(substr($path, $i + strlen('public_html')), '/');
  return '';
}
$WEBBASE = web_base();

function hit($url, $timeout = 12) {
  return @file_get_contents($url, false, stream_context_create([
    'http' => ['timeout' => $timeout, 'ignore_errors' => true],
    'ssl'  => ['verify_peer' => false, 'verify_peer_name' => false],
  ]));
}
function wd_log($msg) {
  global $BASE;
  @file_put_contents($BASE . '/portable/data/logs/watchdog.log',
    '[' . date('c') . '] ' . $msg . "\n", FILE_APPEND);
}

// ── 1) what does the daemon say? ───────────────────────────────────────────
$health = @file_get_contents('http://127.0.0.1:' . $PORT . $WEBBASE . '/health', false,
  stream_context_create(['http' => ['timeout' => 8, 'ignore_errors' => true]]));
$h = ($health !== false && $health !== '') ? @json_decode($health, true) : null;

if (is_array($h) && isset($h['status'])) {
  $mode   = isset($h['mode'])   ? $h['mode']   : 'poll';
  $idle   = isset($h['pollIdleSec']) ? (int)$h['pollIdleSec'] : 0;
  $uptime = isset($h['uptimeSec'])   ? (int)$h['uptimeSec']   : 0;

  if ($mode === 'setup') exit(0);                 // wizard is waiting — healthy

  if ($mode !== 'poll') exit(0);                  // webhook mode: nothing to do

  if ($idle > 600 && $uptime >= 120) {
    wd_log("zombie: polling idle {$idle}s (uptime {$uptime}s) — reboot");
    reboot();
  }
  exit(0);                                        // healthy
}

// ── 2) no answer → dead or hung → reboot via the public gateway ────────────
wd_log('no health response — reboot');
reboot();
exit(0);

function reboot() {
  global $BASE, $OVERRIDE_HOST, $OVERRIDE_PATH;

  $host = isset($OVERRIDE_HOST) ? $OVERRIDE_HOST
    : (php_sapi_name() === 'cli' && function_exists('gethostname') ? gethostname() : '');
  if (empty($host) && !empty($_SERVER['HTTP_HOST'])) $host = $_SERVER['HTTP_HOST'];
  if (empty($host)) $host = 'localhost';

  $path = isset($OVERRIDE_PATH) ? $OVERRIDE_PATH
    : str_replace(DIRECTORY_SEPARATOR, '/', __DIR__); // …/public_html/jinx-harness
  // keep only from public_html onwards if possible
  if (($i = strpos($path, 'public_html')) !== false) $path = '/' . substr($path, $i + strlen('public_html'));
  else $path = '/';

  $url = 'https://' . $host . $path . '/';
  hit($url, 25);
  // one more nudge after a short wait (first request may be spent booting)
  sleep(4);
  hit($url, 25);
}
