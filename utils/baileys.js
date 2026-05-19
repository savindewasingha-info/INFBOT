/**
 * Baileys ES Module Helper
 * Provides a cached dynamic import of @whiskeysockets/baileys
 * Use this instead of require('@whiskeysockets/baileys') everywhere.
 */

let _baileys = null;
let _loadPromise = null;

async function getBaileys() {
  if (_baileys) return _baileys;
  if (!_loadPromise) {
    _loadPromise = import('@whiskeysockets/baileys').then(b => {
      _baileys = b;
      return b;
    });
  }
  return _loadPromise;
}

// Pre-load immediately so sync callers can use getCached* helpers after startup
getBaileys().catch(() => {});

function getCachedBaileys() {
  return _baileys;
}

function jidDecode(jid) {
  if (_baileys && _baileys.jidDecode) return _baileys.jidDecode(jid);
  if (!jid) return null;
  const atIdx = jid.lastIndexOf('@');
  if (atIdx < 0) return null;
  const server = jid.slice(atIdx + 1);
  const rest = jid.slice(0, atIdx);
  const colonIdx = rest.indexOf(':');
  const user = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
  return { user, server };
}

function jidEncode(user, server) {
  if (_baileys && _baileys.jidEncode) return _baileys.jidEncode(user, server);
  return `${user}@${server}`;
}

async function downloadMediaMessage(...args) {
  const b = await getBaileys();
  return b.downloadMediaMessage(...args);
}

async function downloadContentFromMessage(...args) {
  const b = await getBaileys();
  return b.downloadContentFromMessage(...args);
}

module.exports = {
  getBaileys,
  getCachedBaileys,
  jidDecode,
  jidEncode,
  downloadMediaMessage,
  downloadContentFromMessage,
};
