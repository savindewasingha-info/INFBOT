/**
 * competition.js — Competition & Referral Program utility
 * Stores data in SQLite (local) + Firebase (cloud sync)
 */

const crypto  = require('crypto');
const path    = require('path');
const sqlite3 = require('better-sqlite3');
const fb      = require('../firebase');

const db = sqlite3(path.join(__dirname, '../database/bot.db'));

try {
  db.exec(`CREATE TABLE IF NOT EXISTS competitions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1, createdAt INTEGER,
    endDate INTEGER DEFAULT NULL, minPoints INTEGER DEFAULT 10
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS competitors (
    username TEXT PRIMARY KEY, password TEXT NOT NULL, firstName TEXT NOT NULL,
    competitionId TEXT NOT NULL, referralCode TEXT, points INTEGER DEFAULT 0, createdAt INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS referral_uses (
    id TEXT PRIMARY KEY, code TEXT NOT NULL, botId TEXT NOT NULL,
    competitorUsername TEXT NOT NULL, timestamp INTEGER
  )`);
} catch (e) { console.error('Competition DB init error:', e.message); }

// Migrate existing table — add columns if missing
try { db.exec(`ALTER TABLE competitions ADD COLUMN endDate INTEGER DEFAULT NULL`); } catch (_) {}
try { db.exec(`ALTER TABLE competitions ADD COLUMN minPoints INTEGER DEFAULT 10`); } catch (_) {}

function hashPw(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

// ── Competitions ──────────────────────────────────────────────────────────────

function createCompetition(name, endDate, minPoints) {
  const id = 'comp_' + Date.now();
  const now = Date.now();
  const end = endDate ? Number(endDate) : null;
  const min = minPoints != null ? Number(minPoints) : 10;
  db.prepare(`INSERT OR REPLACE INTO competitions VALUES (?,?,1,?,?,?)`).run(id, name, now, end, min);
  fb.fbSet(`competition_data/competitions/${id}`, { id, name, active: true, createdAt: now, endDate: end, minPoints: min }).catch(() => {});
  return { id, name, active: true, createdAt: now, endDate: end, minPoints: min };
}

function getCompetitions() {
  return db.prepare(`SELECT * FROM competitions ORDER BY createdAt DESC`).all().map(c => ({
    ...c,
    active: c.active === 1,
    ended: c.endDate ? Date.now() > c.endDate : false,
    minPoints: c.minPoints != null ? c.minPoints : 10,
  }));
}

function getCompetition(id) {
  const c = db.prepare(`SELECT * FROM competitions WHERE id=?`).get(id);
  if (!c) return null;
  return { ...c, active: c.active === 1, ended: c.endDate ? Date.now() > c.endDate : false, minPoints: c.minPoints != null ? c.minPoints : 10 };
}

function deleteCompetition(id) {
  db.prepare(`DELETE FROM competitions WHERE id=?`).run(id);
  fb.fbRemove(`competition_data/competitions/${id}`).catch(() => {});
}

// ── Competitors ───────────────────────────────────────────────────────────────

function addCompetitor(username, password, firstName, competitionId) {
  const hashed = hashPw(password);
  const now = Date.now();
  db.prepare(`INSERT OR REPLACE INTO competitors VALUES (?,?,?,?,NULL,0,?)`).run(username, hashed, firstName, competitionId, now);
  fb.fbSet(`competition_data/competitors/${username}`, {
    username, password: hashed, firstName, competitionId, referralCode: null, points: 0, createdAt: now
  }).catch(() => {});
  return { username, firstName, competitionId, points: 0, referralCode: null };
}

function getCompetitors(competitionId) {
  if (competitionId) {
    return db.prepare(`SELECT * FROM competitors WHERE competitionId=? ORDER BY points DESC`).all(competitionId);
  }
  return db.prepare(`SELECT * FROM competitors ORDER BY points DESC`).all();
}

function getCompetitor(username) {
  return db.prepare(`SELECT * FROM competitors WHERE username=?`).get(username) || null;
}

function deleteCompetitor(username) {
  db.prepare(`DELETE FROM competitors WHERE username=?`).run(username);
  fb.fbRemove(`competition_data/competitors/${username}`).catch(() => {});
}

function authenticateCompetitor(username, password) {
  const hashed = hashPw(password);
  return db.prepare(`SELECT * FROM competitors WHERE username=? AND password=?`).get(username, hashed) || null;
}

// ── Referral Codes ────────────────────────────────────────────────────────────

function generateReferralCode(username) {
  const comp = getCompetitor(username);
  if (!comp) return null;
  if (comp.referralCode) return comp.referralCode;

  let code;
  for (let i = 0; i < 20; i++) {
    const base = comp.firstName.replace(/[^a-zA-Z]/g, '').slice(0, 20).toLowerCase();
    const digits = Math.floor(Math.random() * 900 + 100);
    code = base + digits;
    const existing = db.prepare(`SELECT username FROM competitors WHERE referralCode=?`).get(code);
    if (!existing) break;
    code = null;
  }
  if (!code) return null;

  db.prepare(`UPDATE competitors SET referralCode=? WHERE username=?`).run(code, username);
  fb.fbUpdate(`competition_data/competitors/${username}`, { referralCode: code }).catch(() => {});
  return code;
}

function getCompetitorByCode(code) {
  return db.prepare(`SELECT * FROM competitors WHERE referralCode=?`).get(code) || null;
}

function awardPoint(code, botId) {
  const comp = getCompetitorByCode(code);
  if (!comp) return false;

  const existing = db.prepare(`SELECT id FROM referral_uses WHERE code=? AND botId=?`).get(code, botId);
  if (existing) return false;

  const useId = 'use_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  db.prepare(`INSERT INTO referral_uses VALUES (?,?,?,?,?)`).run(useId, code, botId, comp.username, Date.now());
  db.prepare(`UPDATE competitors SET points=points+1 WHERE username=?`).run(comp.username);
  const updated = getCompetitor(comp.username);
  fb.fbUpdate(`competition_data/competitors/${comp.username}`, { points: updated?.points || (comp.points + 1) }).catch(() => {});
  return true;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function getLeaderboard(competitionId) {
  const rows = competitionId
    ? db.prepare(`SELECT username, firstName, points, referralCode, competitionId FROM competitors WHERE competitionId=? ORDER BY points DESC`).all(competitionId)
    : db.prepare(`SELECT username, firstName, points, referralCode, competitionId FROM competitors ORDER BY points DESC`).all();

  // Attach competition info (ended, minPoints) for each row
  const compCache = {};
  return rows.map((c, i) => {
    if (!compCache[c.competitionId]) compCache[c.competitionId] = getCompetition(c.competitionId);
    const compInfo = compCache[c.competitionId];
    const minPts = compInfo?.minPoints != null ? compInfo.minPoints : 10;
    const ended = compInfo?.ended || false;
    return {
      ...c,
      rank: i + 1,
      eliminated: ended && c.points < minPts,
      passed: ended && c.points >= minPts,
    };
  });
}

// ── Bootstrap (load from Firebase on startup) ─────────────────────────────────

async function bootstrap() {
  try {
    const comps = await fb.fbGet('competition_data/competitions');
    if (comps && typeof comps === 'object') {
      const stmt = db.prepare(`INSERT OR IGNORE INTO competitions VALUES (?,?,?,?,?,?)`);
      for (const [id, c] of Object.entries(comps)) {
        try { stmt.run(c.id || id, c.name || id, c.active ? 1 : 0, c.createdAt || Date.now(), c.endDate || null, c.minPoints != null ? c.minPoints : 10); } catch {}
      }
    }
    const competitors = await fb.fbGet('competition_data/competitors');
    if (competitors && typeof competitors === 'object') {
      const stmt = db.prepare(`INSERT OR IGNORE INTO competitors VALUES (?,?,?,?,?,?,?)`);
      for (const [username, c] of Object.entries(competitors)) {
        try { stmt.run(c.username || username, c.password || '', c.firstName || username, c.competitionId || '', c.referralCode || null, c.points || 0, c.createdAt || Date.now()); } catch {}
      }
    }
  } catch (e) { console.error('Competition bootstrap error:', e.message); }
}

module.exports = {
  createCompetition, getCompetitions, getCompetition, deleteCompetition,
  addCompetitor, getCompetitors, getCompetitor, deleteCompetitor,
  authenticateCompetitor, generateReferralCode, getCompetitorByCode,
  awardPoint, getLeaderboard, bootstrap,
};
