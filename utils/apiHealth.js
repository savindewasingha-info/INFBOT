/**
 * API Health / Circuit Breaker
 * Tracks success/failure per named API endpoint.
 * Dead after FAIL_THRESHOLD consecutive failures.
 * Auto-recovers after RECOVER_MS.
 */

const FAIL_THRESHOLD = 3;
const RECOVER_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LOG = 30;

const _health = {}; // { [name]: { fails, dead, lastFailAt, lastSuccessAt, successCount } }
const _log = [];

function _init(name) {
  if (!_health[name]) {
    _health[name] = { fails: 0, dead: false, lastFailAt: 0, lastSuccessAt: 0, successCount: 0 };
  }
  return _health[name];
}

function _log_event(msg) {
  _log.unshift({ ts: Date.now(), msg });
  if (_log.length > MAX_LOG) _log.pop();
}

function markSuccess(name) {
  const h = _init(name);
  const wasDown = h.dead;
  h.fails = 0;
  h.dead = false;
  h.lastSuccessAt = Date.now();
  h.successCount++;
  if (wasDown) _log_event(`${name} RECOVERED`);
}

function markFailure(name, errMsg) {
  const h = _init(name);
  h.fails++;
  h.lastFailAt = Date.now();
  if (!h.dead && h.fails >= FAIL_THRESHOLD) {
    h.dead = true;
    _log_event(`${name} DEAD after ${h.fails} fails: ${String(errMsg).slice(0, 80)}`);
  }
}

function isAlive(name) {
  const h = _health[name];
  if (!h || !h.dead) return true;
  if (Date.now() - h.lastFailAt >= RECOVER_MS) {
    h.dead = false;
    h.fails = 0;
    _log_event(`${name} AUTO-RECOVERED (cooldown expired)`);
    return true;
  }
  return false;
}

/**
 * Wrap an API call with health tracking.
 * If the circuit is open (dead), throws immediately without calling fn.
 */
async function withHealth(name, fn) {
  if (!isAlive(name)) {
    const h = _health[name];
    const eta = Math.ceil((RECOVER_MS - (Date.now() - h.lastFailAt)) / 1000);
    throw new Error(`${name} is down (retrying in ~${eta}s)`);
  }
  try {
    const result = await fn();
    markSuccess(name);
    return result;
  } catch (err) {
    markFailure(name, err.message);
    throw err;
  }
}

/**
 * Returns an array of status rows for display.
 */
function getStatus() {
  const now = Date.now();
  return Object.entries(_health).map(([name, h]) => {
    const recovering = h.dead && (now - h.lastFailAt >= RECOVER_MS);
    const icon = h.dead && !recovering ? '❌' : recovering ? '🔄' : '✅';
    const since = h.dead
      ? `down ${Math.round((now - h.lastFailAt) / 1000)}s`
      : h.lastSuccessAt
        ? `ok (${h.successCount} hits)`
        : 'no data';
    return { name, icon, fails: h.fails, since };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function getLog() { return [..._log]; }

module.exports = { withHealth, isAlive, markSuccess, markFailure, getStatus, getLog };
