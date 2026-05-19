const crypto = require('crypto');
const database = require('../database');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function isOwnerUsername(username) {
  // Check env variable first (most flexible), then data flag, then legacy default
  const envOwner = process.env.DASHBOARD_OWNER_USERNAME;
  if (envOwner) return username === envOwner;
  // No env var set — fall back to legacy hardcoded default so existing setups
  // continue working unless they explicitly configure a different owner.
  return username === 'owner123';
}

module.exports = {
  register: async (username, password) => {
    const existing = await database.getDashboardUser(username);
    if (existing) return false;
    await database.saveDashboardUser(username, hashPassword(password));
    return true;
  },
  login: async (username, password) => {
    const user = await database.getDashboardUser(username);
    if (!user) return false;
    if (user.password === hashPassword(password)) {
      // isOwner: true if set explicitly in the user's DB record, OR if username matches owner
      const ownerByRecord = user.data?.isOwner === true;
      const ownerByName   = isOwnerUsername(username);
      return { username, isOwner: ownerByRecord || ownerByName };
    }
    return false;
  },
  // Allows the dashboard to promote/demote a user's owner flag
  setOwnerFlag: async (username, value) => {
    const user = await database.getDashboardUser(username);
    if (!user) return false;
    const data = { ...(user.data || {}), isOwner: !!value };
    await database.saveDashboardUserData(username, data);
    return true;
  },
  hashPassword
};
