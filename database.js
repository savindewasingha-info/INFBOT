/**
 * Database Module - Firebase Realtime Database (primary) + SQLite (local backup)
 * All data is stored in Firebase and kept in memory for sync reads.
 * SQLite is kept as a local fallback cache.
 */

const sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const fb = require('./firebase');

// ─── SQLite Setup (local backup) ──────────────────────────────────────────────
const dbDir = path.join(__dirname, 'database');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = sqlite3(path.join(dbDir, 'bot.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function initSQLite() {
  db.exec(`CREATE TABLE IF NOT EXISTS dashboard_users (username TEXT PRIMARY KEY, password TEXT, data TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT, folder TEXT, name TEXT, ownerName TEXT, ownerNumber TEXT, settings TEXT DEFAULT '{}', creds TEXT, addedAt INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS global_settings (key TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_settings (groupId TEXT PRIMARY KEY, settings TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS moderators (userId TEXT PRIMARY KEY)`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_settings (username TEXT PRIMARY KEY, settings TEXT DEFAULT '{}')`);
  db.exec(`CREATE TABLE IF NOT EXISTS warnings (groupId TEXT, userId TEXT, count INTEGER DEFAULT 0, PRIMARY KEY (groupId, userId))`);
}

try { initSQLite(); } catch (e) { console.error('❌ SQLite init error:', e.message); }

// ─── In-Memory Caches (for sync reads) ────────────────────────────────────────
let globalSettingsCache = {
  maintenance: false,
  forceBot: false,
  antidelete: false,
  autoStatus: false,
  anticall: false
};
let moderatorsCache = [];
let sessionsCache = {};
let groupSettingsCache = {};
let dashboardUsersCache = {};
let userSettingsCache = {};
let warningsCache = {};

// ─── Key Sanitization ─────────────────────────────────────────────────────────
const { sanitizeKey, desanitizeKey, fbSet, fbGet, fbUpdate, fbRemove, fbListen, isFirebaseBlocked } = fb;

// ─── Firebase Write (non-blocking, writes to both Firebase + SQLite) ───────────
function firebaseWrite(path, value) {
  fbSet(path, value).catch(() => {});
}
function firebaseUpdate(path, value) {
  fbUpdate(path, value).catch(() => {});
}
function firebaseRemove(path) {
  fbRemove(path).catch(() => {});
}

// ─── Live Firebase Listeners (real-time cache sync) ───────────────────────────
let _listenersAttached = false;

function attachLiveListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;

  // global_settings
  fbListen('global_settings', (data) => {
    if (!data || typeof data !== 'object') return;
    Object.assign(globalSettingsCache, data);
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(data)) stmt.run(k, JSON.stringify(v));
    } catch {}
  });

  // sessions
  fbListen('sessions', (data) => {
    if (!data || typeof data !== 'object') return;
    const updated = {};
    for (const [sKey, sData] of Object.entries(data)) {
      const id = desanitizeKey(sKey);
      updated[id] = {
        ...sData,
        settings: typeof sData.settings === 'string' ? JSON.parse(sData.settings) : (sData.settings || {})
      };
    }
    // Merge: update existing keys and add new ones; remove keys deleted in Firebase
    for (const id of Object.keys(sessionsCache)) {
      if (!updated[id]) delete sessionsCache[id];
    }
    Object.assign(sessionsCache, updated);
    // Sync to SQLite
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO sessions (id, userId, folder, name, ownerName, ownerNumber, settings, creds, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const [id, d] of Object.entries(updated)) {
        stmt.run(id, d.userId, d.folder, d.name, d.ownerName, d.ownerNumber, JSON.stringify(d.settings || {}), d.creds || null, d.addedAt || Date.now());
      }
    } catch {}
  });

  // dashboard_users
  fbListen('dashboard_users', (data) => {
    if (!data || typeof data !== 'object') return;
    // Merge — add/update; remove deleted keys
    for (const k of Object.keys(dashboardUsersCache)) {
      if (!data[k]) delete dashboardUsersCache[k];
    }
    Object.assign(dashboardUsersCache, data);
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO dashboard_users (username, password, data) VALUES (?, ?, ?)`);
      for (const [username, d] of Object.entries(data)) {
        stmt.run(username, d.password, JSON.stringify(d.data || {}));
      }
    } catch {}
  });

  // moderators
  fbListen('moderators', (data) => {
    if (!data || typeof data !== 'object') {
      moderatorsCache = [];
      return;
    }
    moderatorsCache = Object.keys(data).map(k => desanitizeKey(k));
  });

  // group_settings
  fbListen('group_settings', (data) => {
    if (!data || typeof data !== 'object') return;
    // Rebuild the full cache from Firebase to stay in sync
    const rebuilt = {};
    for (const [gKey, settings] of Object.entries(data)) {
      const groupId = desanitizeKey(gKey);
      rebuilt[groupId] = typeof settings === 'string' ? JSON.parse(settings) : settings;
    }
    // Replace cache entirely (Firebase is the source of truth)
    for (const k of Object.keys(groupSettingsCache)) delete groupSettingsCache[k];
    Object.assign(groupSettingsCache, rebuilt);
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO group_settings (groupId, settings) VALUES (?, ?)`);
      for (const [groupId, s] of Object.entries(rebuilt)) stmt.run(groupId, JSON.stringify(s));
    } catch {}
  });

  // user_settings
  fbListen('user_settings', (data) => {
    if (!data || typeof data !== 'object') return;
    for (const k of Object.keys(userSettingsCache)) {
      if (!data[k]) delete userSettingsCache[k];
    }
    for (const [username, settings] of Object.entries(data)) {
      userSettingsCache[username] = typeof settings === 'string' ? JSON.parse(settings) : settings;
    }
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO user_settings (username, settings) VALUES (?, ?)`);
      for (const [username, s] of Object.entries(userSettingsCache)) stmt.run(username, JSON.stringify(s));
    } catch {}
  });

  // warnings
  fbListen('warnings', (data) => {
    if (!data || typeof data !== 'object') {
      for (const k of Object.keys(warningsCache)) delete warningsCache[k];
      return;
    }
    const rebuilt = {};
    for (const [gKey, userWarns] of Object.entries(data)) {
      const groupId = desanitizeKey(gKey);
      rebuilt[groupId] = {};
      if (userWarns && typeof userWarns === 'object') {
        for (const [uKey, count] of Object.entries(userWarns)) {
          rebuilt[groupId][desanitizeKey(uKey)] = count;
        }
      }
    }
    for (const k of Object.keys(warningsCache)) delete warningsCache[k];
    Object.assign(warningsCache, rebuilt);
  });

  console.log('🔴 Firebase real-time listeners attached (live sync active)');
}

// ─── Bootstrap: Load from Firebase, migrate from SQLite if needed ──────────────
let _ready = false;
let _readyResolve;
const readyPromise = new Promise(r => { _readyResolve = r; });

// ─── SQLite-only bootstrap helper ─────────────────────────────────────────────
function loadAllFromSQLite() {
  const rows = db.prepare('SELECT * FROM global_settings').all();
  rows.forEach(row => {
    try { globalSettingsCache[row.key] = JSON.parse(row.value); }
    catch { globalSettingsCache[row.key] = row.value; }
  });

  moderatorsCache = db.prepare('SELECT userId FROM moderators').all().map(r => r.userId);

  const sessionRows = db.prepare('SELECT * FROM sessions').all();
  sessionRows.forEach(row => {
    sessionsCache[row.id] = {
      userId: row.userId, folder: row.folder, name: row.name,
      ownerName: row.ownerName, ownerNumber: row.ownerNumber,
      settings: JSON.parse(row.settings || '{}'),
      creds: row.creds, addedAt: row.addedAt
    };
  });
  if (sessionRows.length) console.log(`📦 Loaded ${sessionRows.length} sessions from SQLite`);

  const userRows = db.prepare('SELECT * FROM dashboard_users').all();
  userRows.forEach(row => {
    dashboardUsersCache[row.username] = { password: row.password, data: JSON.parse(row.data || '{}') };
  });
  if (userRows.length) console.log(`📦 Loaded ${userRows.length} dashboard users from SQLite`);

  const groupRows = db.prepare('SELECT * FROM group_settings').all();
  groupRows.forEach(row => {
    try { groupSettingsCache[row.groupId] = JSON.parse(row.settings); } catch {}
  });
  if (groupRows.length) console.log(`📦 Loaded ${groupRows.length} group settings from SQLite`);

  const uRows = db.prepare('SELECT * FROM user_settings').all();
  uRows.forEach(row => {
    try { userSettingsCache[row.username] = JSON.parse(row.settings || '{}'); } catch {}
  });

  const wRows = db.prepare('SELECT * FROM warnings').all();
  wRows.forEach(row => {
    if (!warningsCache[row.groupId]) warningsCache[row.groupId] = {};
    warningsCache[row.groupId][row.userId] = row.count;
  });
}

async function bootstrapFromFirebase() {
  try {
    console.log('🔥 Loading data from Firebase...');

    // ── Global settings ────────────────────────────────────────────────────────
    const fbGlobalSettings = await fbGet('global_settings');
    if (fbGlobalSettings && typeof fbGlobalSettings === 'object') {
      Object.assign(globalSettingsCache, fbGlobalSettings);
      const stmt = db.prepare(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(fbGlobalSettings)) {
        try { stmt.run(k, JSON.stringify(v)); } catch {}
      }
    } else if (!isFirebaseBlocked()) {
      // Firebase is reachable but path is empty — migrate from SQLite
      const rows = db.prepare('SELECT * FROM global_settings').all();
      if (rows.length > 0) {
        const settings = {};
        rows.forEach(row => {
          try { settings[row.key] = JSON.parse(row.value); }
          catch { settings[row.key] = row.value; }
          globalSettingsCache[row.key] = settings[row.key];
        });
        await fbSet('global_settings', settings);
        console.log('📤 Migrated global_settings to Firebase');
      }
    } else {
      // Firebase is blocked — load from SQLite silently
      const rows = db.prepare('SELECT * FROM global_settings').all();
      rows.forEach(row => {
        try { globalSettingsCache[row.key] = JSON.parse(row.value); }
        catch { globalSettingsCache[row.key] = row.value; }
      });
    }

    // ── Sessions ───────────────────────────────────────────────────────────────
    const fbSessions = await fbGet('sessions');
    if (fbSessions && typeof fbSessions === 'object') {
      for (const [sKey, data] of Object.entries(fbSessions)) {
        const id = desanitizeKey(sKey);
        sessionsCache[id] = {
          ...data,
          settings: typeof data.settings === 'string' ? JSON.parse(data.settings) : (data.settings || {})
        };
        try {
          db.prepare(`INSERT OR REPLACE INTO sessions (id, userId, folder, name, ownerName, ownerNumber, settings, creds, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, data.userId, data.folder, data.name, data.ownerName, data.ownerNumber, JSON.stringify(data.settings || {}), data.creds || null, data.addedAt || Date.now());
        } catch {}
      }
      console.log(`📥 Loaded ${Object.keys(fbSessions).length} sessions from Firebase`);
    } else if (!isFirebaseBlocked()) {
      // Migrate from SQLite → Firebase
      const rows = db.prepare('SELECT * FROM sessions').all();
      if (rows.length > 0) {
        for (const row of rows) {
          const id = row.id;
          const data = {
            userId: row.userId || null, folder: row.folder || null,
            name: row.name || null, ownerName: row.ownerName || null,
            ownerNumber: row.ownerNumber || null,
            settings: JSON.parse(row.settings || '{}'),
            creds: row.creds || null, addedAt: row.addedAt || Date.now()
          };
          sessionsCache[id] = data;
          await fbSet(`sessions/${sanitizeKey(id)}`, { ...data, settings: data.settings });
        }
        console.log(`📤 Migrated ${rows.length} sessions to Firebase`);
      }
      // Also check sessions.json
      const sessionsJsonPath = path.join(dbDir, 'sessions.json');
      if (fs.existsSync(sessionsJsonPath)) {
        try {
          const jsonSessions = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
          for (const [id, data] of Object.entries(jsonSessions)) {
            if (!sessionsCache[id]) {
              sessionsCache[id] = { ...data, settings: data.settings || {} };
              await fbSet(`sessions/${sanitizeKey(id)}`, sessionsCache[id]);
            }
          }
          console.log('📤 Migrated sessions.json to Firebase');
        } catch {}
      }
    } else {
      // Firebase blocked — load from SQLite
      const rows = db.prepare('SELECT * FROM sessions').all();
      rows.forEach(row => {
        sessionsCache[row.id] = {
          userId: row.userId, folder: row.folder, name: row.name,
          ownerName: row.ownerName, ownerNumber: row.ownerNumber,
          settings: JSON.parse(row.settings || '{}'), creds: row.creds, addedAt: row.addedAt
        };
      });
      if (rows.length) console.log(`📦 Loaded ${rows.length} sessions from SQLite (Firebase blocked)`);
    }

    // ── Dashboard users ────────────────────────────────────────────────────────
    const fbUsers = await fbGet('dashboard_users');
    if (fbUsers && typeof fbUsers === 'object') {
      Object.assign(dashboardUsersCache, fbUsers);
      for (const [username, data] of Object.entries(fbUsers)) {
        try {
          db.prepare(`INSERT OR REPLACE INTO dashboard_users (username, password, data) VALUES (?, ?, ?)`)
            .run(username, data.password, JSON.stringify(data.data || {}));
        } catch {}
      }
      console.log(`📥 Loaded ${Object.keys(fbUsers).length} dashboard users from Firebase`);
    } else if (!isFirebaseBlocked()) {
      const rows = db.prepare('SELECT * FROM dashboard_users').all();
      if (rows.length > 0) {
        const users = {};
        rows.forEach(row => {
          users[row.username] = { password: row.password, data: JSON.parse(row.data || '{}') };
          dashboardUsersCache[row.username] = users[row.username];
        });
        await fbSet('dashboard_users', users);
        console.log(`📤 Migrated ${rows.length} dashboard users to Firebase`);
      }
    } else {
      const rows = db.prepare('SELECT * FROM dashboard_users').all();
      rows.forEach(row => {
        dashboardUsersCache[row.username] = { password: row.password, data: JSON.parse(row.data || '{}') };
      });
      if (rows.length) console.log(`📦 Loaded ${rows.length} dashboard users from SQLite (Firebase blocked)`);
    }

    // ── Moderators ─────────────────────────────────────────────────────────────
    const fbMods = await fbGet('moderators');
    if (fbMods && typeof fbMods === 'object') {
      moderatorsCache = Object.keys(fbMods).map(k => desanitizeKey(k));
      for (const userId of moderatorsCache) {
        try { db.prepare(`INSERT OR IGNORE INTO moderators (userId) VALUES (?)`).run(userId); } catch {}
      }
    } else if (!isFirebaseBlocked()) {
      const rows = db.prepare('SELECT userId FROM moderators').all();
      if (rows.length > 0) {
        moderatorsCache = rows.map(r => r.userId);
        const modsObj = {};
        moderatorsCache.forEach(id => { modsObj[sanitizeKey(id)] = true; });
        await fbSet('moderators', modsObj);
        console.log(`📤 Migrated ${rows.length} moderators to Firebase`);
      }
    } else {
      moderatorsCache = db.prepare('SELECT userId FROM moderators').all().map(r => r.userId);
    }

    // ── Group settings ─────────────────────────────────────────────────────────
    const fbGroups = await fbGet('group_settings');
    if (fbGroups && typeof fbGroups === 'object') {
      for (const [gKey, settings] of Object.entries(fbGroups)) {
        const groupId = desanitizeKey(gKey);
        groupSettingsCache[groupId] = typeof settings === 'string' ? JSON.parse(settings) : settings;
        try {
          db.prepare(`INSERT OR REPLACE INTO group_settings (groupId, settings) VALUES (?, ?)`)
            .run(groupId, JSON.stringify(groupSettingsCache[groupId]));
        } catch {}
      }
      console.log(`📥 Loaded ${Object.keys(fbGroups).length} group settings from Firebase`);
    } else if (!isFirebaseBlocked()) {
      const rows = db.prepare('SELECT * FROM group_settings').all();
      if (rows.length > 0) {
        const groups = {};
        rows.forEach(row => {
          try {
            const s = JSON.parse(row.settings);
            groupSettingsCache[row.groupId] = s;
            groups[sanitizeKey(row.groupId)] = s;
          } catch {}
        });
        await fbSet('group_settings', groups);
        console.log(`📤 Migrated ${rows.length} group settings to Firebase`);
      }
    } else {
      const rows = db.prepare('SELECT * FROM group_settings').all();
      rows.forEach(row => {
        try { groupSettingsCache[row.groupId] = JSON.parse(row.settings); } catch {}
      });
      if (rows.length) console.log(`📦 Loaded ${rows.length} group settings from SQLite (Firebase blocked)`);
    }

    // ── User settings ──────────────────────────────────────────────────────────
    const fbUserSettings = await fbGet('user_settings');
    if (fbUserSettings && typeof fbUserSettings === 'object') {
      for (const [username, settings] of Object.entries(fbUserSettings)) {
        userSettingsCache[username] = typeof settings === 'string' ? JSON.parse(settings) : settings;
        try {
          db.prepare(`INSERT OR REPLACE INTO user_settings (username, settings) VALUES (?, ?)`)
            .run(username, JSON.stringify(userSettingsCache[username]));
        } catch {}
      }
    } else if (!isFirebaseBlocked()) {
      const rows = db.prepare('SELECT * FROM user_settings').all();
      if (rows.length > 0) {
        const usettings = {};
        rows.forEach(row => {
          try {
            const s = JSON.parse(row.settings);
            userSettingsCache[row.username] = s;
            usettings[row.username] = s;
          } catch {}
        });
        await fbSet('user_settings', usettings);
      }
    } else {
      const rows = db.prepare('SELECT * FROM user_settings').all();
      rows.forEach(row => {
        try { userSettingsCache[row.username] = JSON.parse(row.settings || '{}'); } catch {}
      });
    }

    // ── Warnings ───────────────────────────────────────────────────────────────
    const fbWarnings = await fbGet('warnings');
    if (fbWarnings && typeof fbWarnings === 'object') {
      for (const [gKey, userWarns] of Object.entries(fbWarnings)) {
        const groupId = desanitizeKey(gKey);
        warningsCache[groupId] = {};
        if (userWarns && typeof userWarns === 'object') {
          for (const [uKey, count] of Object.entries(userWarns)) {
            warningsCache[groupId][desanitizeKey(uKey)] = count;
          }
        }
      }
    } else if (!isFirebaseBlocked()) {
      try {
        const rows = db.prepare('SELECT * FROM warnings').all();
        if (rows.length > 0) {
          const warns = {};
          rows.forEach(row => {
            if (!warningsCache[row.groupId]) warningsCache[row.groupId] = {};
            warningsCache[row.groupId][row.userId] = row.count;
            const gk = sanitizeKey(row.groupId);
            if (!warns[gk]) warns[gk] = {};
            warns[gk][sanitizeKey(row.userId)] = row.count;
          });
          await fbSet('warnings', warns);
        }
      } catch {}
    } else {
      const rows = db.prepare('SELECT * FROM warnings').all();
      rows.forEach(row => {
        if (!warningsCache[row.groupId]) warningsCache[row.groupId] = {};
        warningsCache[row.groupId][row.userId] = row.count;
      });
    }

    if (isFirebaseBlocked()) {
      console.warn('⚠️  Firebase is blocked (permission_denied). Running on SQLite only.');
      console.warn('⚠️  Fix: Go to Firebase Console → Realtime Database → Rules and set:');
      console.warn('       { "rules": { ".read": true, ".write": true } }');
      console.warn('       (or use firebase-admin with a service account for proper security)');
    }
    console.log('✅ Global settings loaded into cache');

    // ── Attach live Firebase listeners (only if Firebase is accessible) ─────────
    if (!isFirebaseBlocked()) {
      attachLiveListeners();
    } else {
      console.log('⏭️  Skipping Firebase listeners (Firebase blocked — using SQLite only)');
    }

    _ready = true;
    _readyResolve(!isFirebaseBlocked());
  } catch (e) {
    console.error('❌ Firebase bootstrap error:', e.message);
    // Hard fallback — load everything from SQLite
    try { loadAllFromSQLite(); } catch {}
    console.log('✅ Global settings loaded into cache (SQLite fallback)');
    _ready = true;
    _readyResolve(false);
  }
}

// Start bootstrap
bootstrapFromFirebase();

// ─── Module Exports ────────────────────────────────────────────────────────────
module.exports = {

  /** Wait for Firebase to finish loading */
  ready: () => readyPromise,

  // ── Dashboard Users ──
  saveDashboardUser: async (username, password) => {
    const data = dashboardUsersCache[username]?.data || {};
    dashboardUsersCache[username] = { password, data };
    // Firebase
    firebaseSet_(`dashboard_users/${sanitizeKey(username)}`, { password, data });
    // SQLite
    try { db.prepare(`INSERT OR REPLACE INTO dashboard_users (username, password, data) VALUES (?, ?, ?)`).run(username, password, JSON.stringify(data)); } catch {}
    return true;
  },

  saveDashboardUserData: async (username, data) => {
    const current = dashboardUsersCache[username];
    if (!current) return false;
    dashboardUsersCache[username] = { ...current, data };
    firebaseUpdate(`dashboard_users/${sanitizeKey(username)}`, { data });
    try { db.prepare(`UPDATE dashboard_users SET data = ? WHERE username = ?`).run(JSON.stringify(data), username); } catch {}
    return true;
  },

  getDashboardUser: async (username) => {
    if (dashboardUsersCache[username]) return { username, ...dashboardUsersCache[username] };
    // Try Firebase
    const fbUser = await fbGet(`dashboard_users/${sanitizeKey(username)}`);
    if (fbUser) { dashboardUsersCache[username] = fbUser; return { username, ...fbUser }; }
    // Try SQLite
    try { return db.prepare('SELECT * FROM dashboard_users WHERE username = ?').get(username); } catch { return null; }
  },

  // ── Global Settings ──
  getGlobalSettings: async () => globalSettingsCache,
  getGlobalSettingsSync: () => globalSettingsCache,

  updateGlobalSettings: async (settings) => {
    Object.assign(globalSettingsCache, settings);
    // Firebase
    firebaseUpdate('global_settings', settings);
    // SQLite
    try {
      const stmt = db.prepare(`INSERT OR REPLACE INTO global_settings (key, value) VALUES (?, ?)`);
      for (const [k, v] of Object.entries(settings)) stmt.run(k, JSON.stringify(v));
    } catch {}
    return true;
  },

  // ── Group Settings ──
  getGroupSettings: async (groupId) => {
    if (groupSettingsCache[groupId]) return groupSettingsCache[groupId];
    const { defaultGroupSettings } = require('./config');
    const defaults = { ...defaultGroupSettings };
    groupSettingsCache[groupId] = defaults;
    // Save defaults
    firebaseSet_(`group_settings/${sanitizeKey(groupId)}`, defaults);
    try { db.prepare(`INSERT OR IGNORE INTO group_settings (groupId, settings) VALUES (?, ?)`).run(groupId, JSON.stringify(defaults)); } catch {}
    return defaults;
  },

  updateGroupSettings: async (groupId, settings) => {
    const current = groupSettingsCache[groupId] || {};
    const updated = { ...current, ...settings };
    groupSettingsCache[groupId] = updated;
    // Firebase
    firebaseUpdate(`group_settings/${sanitizeKey(groupId)}`, settings);
    // SQLite
    try { db.prepare(`INSERT OR REPLACE INTO group_settings (groupId, settings) VALUES (?, ?)`).run(groupId, JSON.stringify(updated)); } catch {}
    return updated;
  },

  // ── Moderators ──
  getModerators: async () => moderatorsCache,
  isModerator: (userId) => moderatorsCache.includes(userId),

  addModerator: async (userId) => {
    if (!moderatorsCache.includes(userId)) {
      moderatorsCache.push(userId);
      firebaseSet_(`moderators/${sanitizeKey(userId)}`, true);
      try { db.prepare(`INSERT OR IGNORE INTO moderators (userId) VALUES (?)`).run(userId); } catch {}
    }
    return true;
  },

  removeModerator: async (userId) => {
    moderatorsCache = moderatorsCache.filter(id => id !== userId);
    firebaseRemove(`moderators/${sanitizeKey(userId)}`);
    try { db.prepare(`DELETE FROM moderators WHERE userId = ?`).run(userId); } catch {}
    return true;
  },

  // ── Sessions ──
  getAllSessions: async () => ({ ...sessionsCache }),

  // Merge partial fields into an existing session (does NOT overwrite unmentioned fields)
  patchSession: async (id, patch) => {
    if (!sessionsCache[id]) return false;
    Object.assign(sessionsCache[id], patch);
    firebaseUpdate(`sessions/${sanitizeKey(id)}`, patch);
    return true;
  },

  // Update only the settings sub-object of a session (merges, does not replace)
  updateSessionSettings: async (id, settings) => {
    if (!sessionsCache[id]) return false;
    const current = sessionsCache[id].settings || {};
    const updated = { ...current, ...settings };
    sessionsCache[id].settings = updated;
    firebaseUpdate(`sessions/${sanitizeKey(id)}`, { settings: updated });
    try { db.prepare(`UPDATE sessions SET settings = ? WHERE id = ?`).run(JSON.stringify(updated), id); } catch {}
    return updated;
  },

  getSessionSettings: (id) => {
    return sessionsCache[id]?.settings || {};
  },

  saveSession: async (id, data) => {
    const existing = sessionsCache[id] || {};
    const sessionData = {
      userId: data.userId || existing.userId || null,
      folder: data.folder || existing.folder || null,
      name: data.name || existing.name || null,
      ownerName: data.ownerName || existing.ownerName || null,
      ownerNumber: data.ownerNumber || existing.ownerNumber || null,
      settings: data.settings || existing.settings || {},
      creds: data.creds || existing.creds || null,
      addedAt: data.addedAt || existing.addedAt || Date.now(),
      // preserve flags set by runtime
      firstConnectDone: data.firstConnectDone !== undefined ? data.firstConnectDone : (existing.firstConnectDone || false),
      paused: data.paused !== undefined ? data.paused : (existing.paused || false)
    };
    sessionsCache[id] = sessionData;
    // Firebase
    firebaseSet_(`sessions/${sanitizeKey(id)}`, sessionData);
    // SQLite
    try {
      db.prepare(`INSERT OR REPLACE INTO sessions (id, userId, folder, name, ownerName, ownerNumber, settings, creds, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sessionData.userId, sessionData.folder, sessionData.name, sessionData.ownerName, sessionData.ownerNumber, JSON.stringify(sessionData.settings), sessionData.creds, sessionData.addedAt);
    } catch {}
    return true;
  },

  saveSessionCreds: async (id, creds) => {
    if (sessionsCache[id]) sessionsCache[id].creds = creds;
    // Firebase
    firebaseUpdate(`sessions/${sanitizeKey(id)}`, { creds });
    // SQLite
    try { db.prepare(`UPDATE sessions SET creds = ? WHERE id = ?`).run(creds, id); } catch {}
    return true;
  },

  deleteSession: async (id) => {
    delete sessionsCache[id];
    await fb.fbRemove(`sessions/${sanitizeKey(id)}`).catch(() => {});
    try { db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id); } catch {}
    return true;
  },

  // ── User Settings ──
  getUserSettings: async (username) => {
    if (userSettingsCache[username]) return userSettingsCache[username];
    const fbData = await fbGet(`user_settings/${sanitizeKey(username)}`);
    if (fbData) { userSettingsCache[username] = fbData; return fbData; }
    return {};
  },

  updateUserSettings: async (username, settings) => {
    const current = userSettingsCache[username] || {};
    const updated = { ...current, ...settings };
    userSettingsCache[username] = updated;
    // Firebase
    firebaseSet_(`user_settings/${sanitizeKey(username)}`, updated);
    // SQLite
    try { db.prepare(`INSERT OR REPLACE INTO user_settings (username, settings) VALUES (?, ?)`).run(username, JSON.stringify(updated)); } catch {}
    return updated;
  },

  // ── Warnings ──
  addWarning: (groupId, userId, reason) => {
    if (!warningsCache[groupId]) warningsCache[groupId] = {};
    const count = (warningsCache[groupId][userId] || 0) + 1;
    warningsCache[groupId][userId] = count;
    // Firebase
    firebaseSet_(`warnings/${sanitizeKey(groupId)}/${sanitizeKey(userId)}`, count);
    // SQLite
    try {
      db.prepare(`INSERT INTO warnings (groupId, userId, count) VALUES (?, ?, 1) ON CONFLICT(groupId, userId) DO UPDATE SET count = count + 1`)
        .run(groupId, userId);
    } catch {}
    return count;
  },

  getWarnings: (groupId, userId) => {
    return warningsCache[groupId]?.[userId] || 0;
  },

  clearWarnings: (groupId, userId) => {
    if (warningsCache[groupId]) delete warningsCache[groupId][userId];
    firebaseRemove(`warnings/${sanitizeKey(groupId)}/${sanitizeKey(userId)}`);
    try { db.prepare(`DELETE FROM warnings WHERE groupId = ? AND userId = ?`).run(groupId, userId); } catch {}
    return true;
  },

  // ── Deleted Messages Cache (in-memory only) ──
  deletedMessagesCache: new Map(),
  saveDeletedMessage: (id, data) => {
    module.exports.deletedMessagesCache.set(id, data);
    setTimeout(() => module.exports.deletedMessagesCache.delete(id), 3600000);
  },
  getDeletedMessage: (id) => module.exports.deletedMessagesCache.get(id),

  // ── Raw SQL query (SQLite only, for legacy compatibility) ──
  query: async (sql, params = []) => {
    try {
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return db.prepare(sql).all(...params);
      }
      return db.prepare(sql).run(...params);
    } catch (e) {
      console.error('SQL query error:', e.message);
      return null;
    }
  },

  run: async (sql, params = []) => {
    try {
      return db.prepare(sql).run(...params);
    } catch (e) {
      console.error('SQL run error:', e.message);
      return null;
    }
  }
};

// Internal helper (avoids circular ref on module.exports not ready)
function firebaseSet_(path, value) {
  fbSet(path, value).catch(() => {});
}
