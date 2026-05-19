const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(process.cwd(), 'database', 'lightweight_store.json');

// Ensure directory exists
if (!fs.existsSync(path.dirname(STORE_PATH))) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
}

const loadStore = () => {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
};

const saveStore = (data) => {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
};

module.exports = {
  saveSetting: async (scope, key, value) => {
    const store = loadStore();
    if (!store[scope]) store[scope] = {};
    store[scope][key] = value;
    saveStore(store);
  },
  getSetting: async (scope, key) => {
    const store = loadStore();
    return store[scope] ? store[scope][key] : null;
  }
};
