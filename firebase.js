const { initializeApp, getApps } = require('firebase/app');
const {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  child,
  push,
  onValue
} = require('firebase/database');

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBRoTFN1U0F1YgpPmcP9GP7y4brsGolFjQ",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || "cupcake-25862.firebaseapp.com",
  databaseURL: process.env.FIREBASE_DATABASE_URL || "https://cupcake-25862-default-rtdb.firebaseio.com",
  projectId: process.env.FIREBASE_PROJECT_ID || "cupcake-25862",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "cupcake-25862.firebasestorage.app",
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "479443761968",
  appId: process.env.FIREBASE_APP_ID || "1:479443761968:web:53d2094960eb83a386e6f5",
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-8B2L4D0983"
};

let app;
let database;
let _firebaseBlocked = false;

/** True once any operation has returned permission_denied */
function isFirebaseBlocked() { return _firebaseBlocked; }

function initFirebase() {
  try {
    const existingApps = getApps();
    app = existingApps.length > 0 ? existingApps[0] : initializeApp(firebaseConfig);
    database = getDatabase(app);
    console.log('🔥 Firebase initialized successfully');
    return true;
  } catch (e) {
    console.error('❌ Firebase init error:', e.message);
    return false;
  }
}

function getDB() {
  return database;
}

function dbRef(path) {
  return ref(database, path);
}

function sanitizeKey(key) {
  if (!key) return '_empty_';
  return String(key)
    .replace(/\./g, ',')
    .replace(/[#$[\]/]/g, '_');
}

function desanitizeKey(key) {
  if (!key) return key;
  return String(key).replace(/,/g, '.');
}

async function fbSet(path, value) {
  try {
    await set(ref(database, path), value);
    return true;
  } catch (e) {
    if (e.message && e.message.toLowerCase().includes('permission')) _firebaseBlocked = true;
    console.error(`❌ Firebase set error [${path}]:`, e.message);
    return false;
  }
}

async function fbGet(path) {
  try {
    const snapshot = await get(ref(database, path));
    return snapshot.exists() ? snapshot.val() : null;
  } catch (e) {
    if (e.message && e.message.toLowerCase().includes('permission')) _firebaseBlocked = true;
    console.error(`❌ Firebase get error [${path}]:`, e.message);
    return null;
  }
}

async function fbUpdate(path, value) {
  try {
    await update(ref(database, path), value);
    return true;
  } catch (e) {
    console.error(`❌ Firebase update error [${path}]:`, e.message);
    return false;
  }
}

async function fbRemove(path) {
  try {
    await remove(ref(database, path));
    return true;
  } catch (e) {
    console.error(`❌ Firebase remove error [${path}]:`, e.message);
    return false;
  }
}

/**
 * Attach a real-time listener to a Firebase path.
 * Calls `callback(value)` immediately with current data, then on every change.
 * Returns the unsubscribe function.
 */
function fbListen(path, callback) {
  try {
    const unsubscribe = onValue(ref(database, path), (snapshot) => {
      callback(snapshot.exists() ? snapshot.val() : null);
    }, (err) => {
      console.error(`❌ Firebase listener error [${path}]:`, err.message);
    });
    return unsubscribe;
  } catch (e) {
    console.error(`❌ Firebase fbListen setup error [${path}]:`, e.message);
    return () => {};
  }
}

const initialized = initFirebase();

module.exports = {
  initialized,
  isFirebaseBlocked,
  getDB,
  dbRef,
  sanitizeKey,
  desanitizeKey,
  fbSet,
  fbGet,
  fbUpdate,
  fbRemove,
  fbListen
};
