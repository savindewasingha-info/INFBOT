const STATUS_CACHE_TTL = 24 * 3600000; // 24 hours — matches WhatsApp status lifespan
const STATUS_CACHE_MAX = 200;

// msgId → { buffer, mediaType, mimetype, caption, sender, ts }
const statusCache = new Map();

// Tracks already-saved message IDs so we never send the same status to DM twice
const savedStatusIds = new Set();

// Tracks message IDs currently being downloaded to prevent concurrent duplicate fetches
const pendingDownloads = new Set();

function pruneCache() {
  const now = Date.now();
  for (const [k, v] of statusCache) {
    if (now - v.ts > STATUS_CACHE_TTL) statusCache.delete(k);
  }
  if (statusCache.size > STATUS_CACHE_MAX) {
    const oldest = [...statusCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    oldest.slice(0, statusCache.size - STATUS_CACHE_MAX).forEach(([k]) => statusCache.delete(k));
  }
}

function isAlreadySaved(id) {
  return savedStatusIds.has(id);
}

function markSaved(id) {
  savedStatusIds.add(id);
  // Auto-expire after 24h so the Set doesn't grow forever
  setTimeout(() => savedStatusIds.delete(id), STATUS_CACHE_TTL);
}

function getCache(id) {
  return statusCache.get(id) || null;
}

function setCache(id, entry) {
  pruneCache();
  statusCache.set(id, { ...entry, ts: Date.now() });
}

module.exports = {
  statusCache,
  savedStatusIds,
  pendingDownloads,
  pruneCache,
  isAlreadySaved,
  markSaved,
  getCache,
  setCache
};
