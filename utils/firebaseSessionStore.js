/**
 * FirebaseSessionStore — express-session store backed by Firebase Realtime DB.
 *
 * Why: Railway (and any multi-instance / restart-prone environment) loses all
 * in-memory sessions on every redeploy.  Storing sessions in Firebase makes
 * them survive restarts and be shared across instances automatically.
 *
 * Sessions are stored at:  sessions_web/<encodedSid>
 * (separate from WhatsApp sessions stored at  sessions/<id>)
 */

const { Store } = require('express-session');
const { fbGet, fbSet, fbRemove } = require('../firebase');

/* Encode session IDs so they are safe Firebase path keys.
   express-session uses random bytes -> may contain  /  + = */
function encSid(sid) {
  return Buffer.from(sid).toString('base64')
    .replace(/\//g, '-')
    .replace(/\+/g, '_')
    .replace(/=/g, '');
}

const FB_PREFIX = 'sessions_web/';

class FirebaseSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    /* default TTL = 7 days (seconds) — should match cookie maxAge */
    this.ttl = options.ttl || 7 * 24 * 60 * 60;

    /* Small in-process cache to cut Firebase reads on every request */
    this._cache = new Map();
    this._cacheMs = options.cacheMs || 5000; // cache each entry 5 s
  }

  _cKey(sid) { return encSid(sid); }

  _fromCache(sid) {
    const e = this._cache.get(sid);
    if (!e) return undefined;
    if (Date.now() - e.ts > this._cacheMs) { this._cache.delete(sid); return undefined; }
    return e.val;
  }

  _toCache(sid, val) {
    if (this._cache.size > 2000) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(sid, { val, ts: Date.now() });
  }

  _delCache(sid) { this._cache.delete(sid); }

  get(sid, callback) {
    const cached = this._fromCache(sid);
    if (cached !== undefined) return callback(null, cached);

    fbGet(FB_PREFIX + this._cKey(sid)).then(data => {
      if (!data) { this._toCache(sid, null); return callback(null, null); }

      /* Check expiry */
      if (data.expires && Date.now() > data.expires) {
        this._delCache(sid);
        this.destroy(sid, () => {});
        return callback(null, null);
      }

      this._toCache(sid, data.session || null);
      callback(null, data.session || null);
    }).catch(err => callback(err));
  }

  set(sid, session, callback) {
    const expires = session.cookie?.expires
      ? new Date(session.cookie.expires).getTime()
      : Date.now() + this.ttl * 1000;

    /* Deeply strip all functions so Firebase can store the object */
    function stripFunctions(obj) {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(stripFunctions);
      const out = {};
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === 'function') continue;
        out[key] = (val && typeof val === 'object') ? stripFunctions(val) : val;
      }
      return out;
    }

    const safeSession = stripFunctions(session);
    const payload = { session: safeSession, expires };
    this._toCache(sid, session);

    fbSet(FB_PREFIX + this._cKey(sid), payload)
      .then(() => callback(null))
      .catch((err) => {
        // Surface failures so we can spot issues in Railway logs instead of
        // silently letting the user appear "logged in" with no persisted session.
        console.error('⚠️ Firebase session set failed (login may not persist):', err?.message || err);
        callback(null);
      });
  }

  destroy(sid, callback) {
    this._delCache(sid);
    fbRemove(FB_PREFIX + this._cKey(sid))
      .then(() => callback(null))
      .catch(err => callback(err));
  }

  /* Optional: touch() resets the expiry without changing session data */
  touch(sid, session, callback) {
    this.set(sid, session, callback);
  }
}

module.exports = FirebaseSessionStore;
