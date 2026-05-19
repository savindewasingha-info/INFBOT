const { Store } = require('express-session');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

let _db;
function getDb() {
  if (_db) return _db;
  _db = new Database(path.join(dbDir, 'bot.db'));
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.exec(`CREATE TABLE IF NOT EXISTS web_sessions (
    sid     TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    expires INTEGER
  )`);
  setInterval(() => {
    try { _db.prepare('DELETE FROM web_sessions WHERE expires < ?').run(Date.now()); } catch (_) {}
  }, 60 * 60 * 1000);
  return _db;
}

class SqliteSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    this.ttl = options.ttl || 7 * 24 * 60 * 60;
    try { getDb(); } catch (e) { console.error('❌ SQLite session store init error:', e.message); }
  }

  get(sid, callback) {
    try {
      const row = getDb().prepare('SELECT session, expires FROM web_sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires && Date.now() > row.expires) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      try { callback(null, JSON.parse(row.session)); }
      catch (parseErr) {
        console.error('⚠️ SQLite session JSON parse error for sid', sid, '-', parseErr.message);
        callback(null, null);
      }
    } catch (err) {
      console.error('⚠️ SQLite session get error:', err.message);
      callback(err);
    }
  }

  set(sid, session, callback) {
    const expires = session.cookie?.expires
      ? new Date(session.cookie.expires).getTime()
      : Date.now() + this.ttl * 1000;
    try {
      getDb()
        .prepare('INSERT OR REPLACE INTO web_sessions (sid, session, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(session), expires);
      callback(null);
    } catch (err) {
      console.error('⚠️ SQLite session set error (login will fail):', err.message);
      callback(err);
    }
  }

  destroy(sid, callback) {
    try { getDb().prepare('DELETE FROM web_sessions WHERE sid = ?').run(sid); }
    catch (err) { console.error('⚠️ SQLite session destroy error:', err.message); }
    callback(null);
  }

  touch(sid, session, callback) { this.set(sid, session, callback); }
}

module.exports = SqliteSessionStore;
