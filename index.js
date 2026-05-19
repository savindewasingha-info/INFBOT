const http = require('http');
const fs = require('fs');
const path = require('path');
const { sendConnectManual } = require('./utils/connectManual');

/**
 * Infinity MD - Render Web Service Stable Entry
 * Raw HTTP server starts INSTANTLY for healthchecks, then Express + modules load after.
 */

const PORT = process.env.PORT || 3000;
let app, server, serverReady = false;

const activeSessions = new Map();
global.activeSessions = activeSessions; // expose for command modules
const pendingNotifications = new Map(); // sessionId → [{ jid, text }, ...]
const reconnectingSet    = new Set(); // tracks sessions currently scheduled for reconnect
const activelyConnecting = new Set(); // tracks sessions currently INSIDE connectSession() — hard dedup guard
const replacedSessions   = new Set(); // tracks sessions that stepped aside due to 440 (another instance holds them)
const sessionsDbPath = path.join(__dirname, 'database', 'sessions.json');

function queueNotification(sessionId, jid, text) {
  if (!pendingNotifications.has(sessionId)) pendingNotifications.set(sessionId, []);
  pendingNotifications.get(sessionId).push({ jid, text });
}

async function flushNotifications(sessionId, sock) {
  const msgs = pendingNotifications.get(sessionId);
  if (!msgs || msgs.length === 0) return;
  pendingNotifications.delete(sessionId);
  for (const { jid, text } of msgs) {
    try { await sock.sendMessage(jid, { text }); } catch (e) {
      console.error(`Notification flush failed for ${sessionId}:`, e.message);
    }
  }
}

let pino, Boom, makeWASocket, useMultiFileAuthState, DisconnectReason,
    fetchLatestBaileysVersion, makeCacheableSignalKeyStore, Browsers,
    jidNormalizedUser, baileysDelay, QRCode, pn, logger;
let config, handler, database, auth, competition;
let cachedWAVersion = null;
let whatsAppLoadError = null;

function fallbackLogger() {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => logger || fallbackLogger() };
}

async function loadWhatsAppCore() {
  if (makeWASocket && useMultiFileAuthState && makeCacheableSignalKeyStore && Browsers && pino && QRCode && pn) {
    whatsAppLoadError = null;
    return true;
  }
  try {
    pino = require('pino');
    ({ Boom } = require('@hapi/boom'));
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
    Browsers = baileys.Browsers;
    jidNormalizedUser = baileys.jidNormalizedUser;
    baileysDelay = baileys.delay;
    QRCode = require('qrcode');
    pn = require('awesome-phonenumber').parsePhoneNumber;
    logger = pino({ level: 'silent' });
    whatsAppLoadError = null;
    return true;
  } catch (err) {
    whatsAppLoadError = err;
    logger = logger || fallbackLogger();
    return false;
  }
}

async function getWAVersion() {
  if (cachedWAVersion) return cachedWAVersion;
  try {
    const result = await fetchLatestBaileysVersion();
    cachedWAVersion = result.version;
    return cachedWAVersion;
  } catch (_) {
    return [2, 3000, 1015531055];
  }
}

async function assertWhatsAppReady() {
  await loadWhatsAppCore();
  const missing = [];
  if (!makeWASocket) missing.push('socket');
  if (!useMultiFileAuthState) missing.push('auth');
  if (!makeCacheableSignalKeyStore) missing.push('keys');
  if (!Browsers) missing.push('browser');
  if (!pino) missing.push('logger');
  if (!QRCode) missing.push('qr');
  if (!pn) missing.push('phone');
  if (missing.length) {
    const loadDetail = whatsAppLoadError ? `: ${errorMessage(whatsAppLoadError)}` : '';
    throw new Error(`WhatsApp service is not ready (${missing.join(', ')})${loadDetail}`);
  }
}

function tempBaileysLogger(level = 'fatal') {
  if (!pino) return logger || fallbackLogger();
  return pino({ level }).child({ level });
}

function tempBrowser() {
  if (Browsers?.ubuntu) return Browsers.ubuntu('Chrome');
  if (Browsers?.windows) return Browsers.windows('Chrome');
  return ['Infinity MD', 'Chrome', '1.0.0'];
}

function endTempSocket(sock) {
  if (!sock) return;
  try { sock.ev?.removeAllListeners(); } catch (_) {}
  try { sock.end?.(); } catch (_) {}
}

function safeRemoveDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function errorMessage(err) {
  return err?.message || String(err || 'Unknown error');
}

async function withTimeout(label, ms, task) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function moduleCheck(name, loader) {
  try {
    const loaded = loader();
    return { ok: true, available: !!loaded };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function asyncModuleCheck(name, loader) {
  try {
    const loaded = await loader();
    return { ok: true, available: !!loaded };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

server = http.createServer((req, res) => {
  if (!app) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  // Fast health check before Express middleware chain
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), sessions: activeSessions.size }));
    return;
  }
  app(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('✅ Web server listening on', PORT);

  // Suppress libsignal noise: Bad MAC, decrypt failures, session churn logs.
  // These come from session_cipher.js (console.error), session_builder.js (console.warn),
  // and session_record.js (console.info). None of them cause disconnects — pure noise.
  function _isLibsignalNoise(...args) {
    const msg = String(args[0] || '');
    return (
      msg.includes('Bad MAC') ||
      msg.includes('Decipheriv') ||
      msg.includes('Failed to decrypt message') ||
      msg.includes('Closing open session in favor') ||
      msg.includes('Closing session:') ||        // catches SessionEntry + all variants
      msg.includes('Session error') ||            // all session error flavours
      msg.includes('<Buffer ') ||                 // crypto key/buffer dumps
      msg.includes('_chains:') ||                 // libsignal SessionEntry fields
      msg.includes('registrationId:') ||
      msg.includes('currentRatchet:') ||
      msg.includes('ephemeralKeyPair:') ||
      msg.includes('indexInfo:') ||
      msg.includes('pendingPreKey:') ||
      msg.includes('chainKey:') ||
      msg.includes('chainType:') ||
      msg.includes('baseKeyType:') ||
      msg.includes('remoteIdentityKey:') ||
      msg.includes('messageKeys:') ||
      msg.includes('oldRatchetList:')
    );
  }
  const _origConsoleError = console.error.bind(console);
  const _origConsoleWarn  = console.warn.bind(console);
  const _origConsoleInfo  = console.info.bind(console);
  console.error = (...args) => { if (_isLibsignalNoise(...args)) return; _origConsoleError(...args); };
  console.warn  = (...args) => { if (_isLibsignalNoise(...args)) return; _origConsoleWarn(...args); };
  console.info  = (...args) => { if (_isLibsignalNoise(...args)) return; _origConsoleInfo(...args); };

  process.on('uncaughtException', (err) => {
    const msg = err?.message || '';
    if (msg.includes('Decipheriv') || msg.includes('Bad MAC') || msg.includes('decrypt')) {
      // silently swallow — already filtered above
    } else {
      _origConsoleError('⚠️ Uncaught exception (kept alive):', err);
    }
  });
  process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Unhandled rejection (kept alive):', reason?.message || reason);
  });

  setTimeout(async () => {
    const express = require('express');
    app = express();

    // Trust ALL proxy hops (Railway, Replit, Nginx all add multiple hops)
    app.set('trust proxy', true);
    app.use((req, res, next) => {
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      next();
    });
    app.use(express.json());

    // Use in-memory session store — no file I/O race condition on login redirect.
    // File stores on Railway/ephemeral containers cause "login refreshes" because
    // the session file may not be flushed before the browser's next request arrives.
    const expressSession = require('express-session');
    // Secure cookies only when running behind HTTPS proxy (production).
    // In local dev (plain HTTP) secure:true would silently drop the cookie.
    const isReplit = !!process.env.REPL_ID || !!process.env.REPLIT_DEV_DOMAIN || !!process.env.REPLIT_DOMAINS;
    const isBehindProxy = process.env.NODE_ENV === 'production'
      || !!process.env.RAILWAY_ENVIRONMENT
      || !!process.env.RAILWAY_SERVICE_NAME
      || isReplit;
    // Replit preview embeds the app in a cross-site iframe — needs SameSite=None;Secure.
    // On Railway/production, 'lax' works for normal browser navigation. We force
    // SameSite=None on Replit AND require Secure there. Elsewhere we use 'auto'
    // for the Secure flag so Express only marks the cookie Secure when it truly
    // sees HTTPS via X-Forwarded-Proto. This avoids Express silently DROPPING
    // the Set-Cookie when the proxy header isn't forwarded as expected (a common
    // cause of "login refreshes back to sign in" on Railway custom domains).
    const cookieSameSite = isReplit ? 'none' : 'lax';
    const cookieSecure = isReplit ? true : 'auto';

    // Use Firebase-backed session store on Railway/production so sessions
    // survive restarts and are shared across replicas. Falls back to the
    // default in-memory store if Firebase isn't available.
    let sessionStore;
    try {
      const FirebaseSessionStore = require('./utils/firebaseSessionStore');
      sessionStore = new FirebaseSessionStore({ ttl: 7 * 24 * 60 * 60 });
      console.log('🔐 Firebase session store active');
    } catch (e) {
      console.warn('⚠️ Firebase session store unavailable — using memory store:', e.message);
    }

    app.use(expressSession({
      secret: process.env.SESSION_SECRET || 'infinity-md-secret-2025',
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: isBehindProxy, // trust X-Forwarded-Proto for secure cookies behind a proxy
      store: sessionStore,   // persistent store (SQLite) — falls back to memory if null
      cookie: {
        secure: cookieSecure,
        httpOnly: true,
        sameSite: cookieSameSite,
        maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
      }
    }));

    app.get('/', (req, res) => {
      return res.sendFile(path.join(__dirname, 'views/landing.html'));
    });


    app.get('/robots.txt', (req, res) => {
      res.type('text/plain');
      res.send(
        'User-agent: *\n' +
        'Allow: /\n' +
        'Disallow: /dashboard\n' +
        'Disallow: /api/\n' +
        'Disallow: /login\n' +
        'Disallow: /signup\n' +
        '\n' +
        'Sitemap: https://infinitymd.online/sitemap.xml\n'
      );
    });

    app.get('/sitemap.xml', (req, res) => {
      const now = new Date().toISOString().split('T')[0];
      res.type('application/xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
          http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  <url>
    <loc>https://infinitymd.online/</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
    });

    try {
      await loadWhatsAppCore();
      if (!makeWASocket || !useMultiFileAuthState || !makeCacheableSignalKeyStore || !Browsers) {
        throw whatsAppLoadError || new Error('Baileys exports missing after load');
      }
      console.log('✅ WhatsApp/bot core modules loaded');
    } catch (e) {
      console.error('❌ Bot core module loading error (WhatsApp unavailable):', e.message);
      logger = logger || fallbackLogger();
    }

    if (!fs.existsSync(path.join(__dirname, 'session'))) {
      fs.mkdirSync(path.join(__dirname, 'session'), { recursive: true });
    }

    try {
      require('./config');
      require('./settings');
      config = require('./config');
      handler = require('./handler');
      database = require('./database');
      auth = require('./utils/auth');
      competition = require('./utils/competition');
      competition.bootstrap().catch(e => console.error('Competition bootstrap error:', e.message));
      const { initializeTempSystem } = require('./utils/tempManager');
      const { startCleanup } = require('./utils/cleanup');
      initializeTempSystem();
      startCleanup();
      console.log('✅ All modules loaded successfully');
    } catch (e) {
      console.error('❌ Critical module loading error:', e);
      if (!config) config = require('./config');
      if (!database) {
        try { database = require('./database'); } catch (_) {
          console.error('❌ Database module failed to load');
        }
      }
      if (!auth) {
        try { auth = require('./utils/auth'); } catch (_) {
          console.error('❌ Auth module failed to load');
        }
      }
      if (!handler) {
        console.error('❌ Handler module failed to load - bot commands will not work');
      }
    }

    // ALWAYS register routes — dashboard/login must work even if bot modules failed
    registerRoutes();
    serverReady = true;
    // Pre-fetch WhatsApp version once so QR/pair routes don't need to fetch on demand
    if (fetchLatestBaileysVersion) getWAVersion().catch(() => {});
    initSessions();
  }, 0);
});

async function connectSession(id, sessionData) {
  // ── Hard dedup guard: never run two connectSession calls for the same id ──
  if (activelyConnecting.has(id)) {
    console.log(`⚠️ connectSession(${id.substring(0, 28)}) already running — skipping duplicate`);
    return;
  }
  activelyConnecting.add(id);
  reconnectingSet.delete(id); // we're now actively connecting, not just scheduled

  // Guard: if folder is missing, derive one from the session id
  if (!sessionData.folder) {
    sessionData.folder = `session_${id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30)}`;
    console.warn(`⚠️ Session ${id} had no folder — assigned: ${sessionData.folder}`);
  }
  const sessionFolder = path.join(__dirname, 'session', sessionData.folder);

  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  if (!fs.existsSync(path.join(sessionFolder, 'creds.json')) && sessionData.creds) {
    fs.writeFileSync(path.join(sessionFolder, 'creds.json'), sessionData.creds);
  }

  if (id && id.startsWith('KnightBot!')) {
    try {
      const zlib = require('zlib');
      const b64data = id.split('!')[1];
      const decoded = zlib.gunzipSync(Buffer.from(b64data, 'base64'));
      fs.writeFileSync(path.join(sessionFolder, 'creds.json'), decoded);
    } catch (e) {
      console.error(`Error decoding KnightBot session ${id}:`, e.message);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
  const version = await getWAVersion();

  const newSock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: [sessionData.name || 'Infinity MD', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 15000, // 15s beats Railway's proxy NAT timeout (was 30s)
    retryRequestDelayMs: 1500,
    generateHighQualityLinkPreview: false,
  });

  newSock._customConfig = {
     sessionId: id,
     botName: sessionData.name || 'Infinity MD',
     ownerName: sessionData.ownerName || config.ownerName[0],
     ownerNumber: sessionData.ownerNumber || config.ownerNumber[0],
     settings: sessionData.settings || {},
     userId: sessionData.userId
  };

  if (newSock.ws) {
    newSock.ws.on('error', (err) => {
      console.error(`⚠️ WebSocket error for session ${id.substring(0, 20)}...:`, err?.message || err);
    });
  }

  newSock.ev.on('creds.update', async () => {
    await saveCreds();
    const credsData = fs.readFileSync(path.join(sessionFolder, 'creds.json'), 'utf8');
    await database.saveSessionCreds(id, credsData);
  });

  newSock.ev.on('call', async (callUpdate) => {
    for (const call of callUpdate) {
      if (call.status === 'offer') {
        try {
          const anticall = require('./commands/owner/anticall');
          if (anticall && typeof anticall.onCall === 'function') {
            await anticall.onCall(newSock, call);
          }
        } catch (e) {
          console.error('Call handling error:', e);
        }
      }
    }
  });

  const MAX_RETRY_COUNT = 50; // give up after this many consecutive failures

  newSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      // isFirstConnect uses the PERSISTENT flag from the DB, not an in-memory flag.
      // This ensures the welcome message is sent only once, even after server restarts.
      const isFirstConnect = !sessionData.firstConnectDone;
      activeSessions.set(id, newSock);
      activelyConnecting.delete(id); // connected — no longer "connecting"
      replacedSessions.delete(id); // clear 440 step-aside flag — this instance now owns the session
      sessionData._retryCount = 0;
      sessionData._longBackoffCount = 0; // reset ban-retry counter on success
      sessionData._connectedAt = Date.now();
      console.log(`✅ Session ${id} connected!`);

      // Wait 2s for connection to fully stabilise before sending any messages
      setTimeout(async () => {
        if (!activeSessions.has(id)) return; // disconnected already

        if (isFirstConnect) {
          try {
            const ownerNum = sessionData.ownerNumber || config.ownerNumber[0];
            if (ownerNum) {
              const ownerJid = ownerNum.includes('@') ? ownerNum : `${ownerNum}@s.whatsapp.net`;
              const botNum = (newSock.user?.id || '').split(':')[0].split('@')[0];
              const botName = sessionData.name || 'Infinity MD';
              const ownerName = sessionData.ownerName || 'Owner';
              const now = new Date().toLocaleString('en-US', {
                timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short'
              });
              const notifMsg =
                `🤖 *New Bot Session Connected!*\n\n` +
                `• *Bot Name:* ${botName}\n` +
                `• *Bot Number:* +${botNum}\n` +
                `• *Owner:* ${ownerName}\n` +
                `• *Connected At:* ${now}\n\n` +
                `_Your bot is now live and ready to use! 🚀_`;
              await newSock.sendMessage(ownerJid, { text: notifMsg });
              console.log(`📲 Owner notified for new session ${id}`);

              // Send bilingual bot manual
              const prefix = sessionData.settings?.prefix || config.prefix || '.';
              await sendConnectManual(newSock, ownerJid, { botName, botNum, prefix });
              console.log(`📖 Bot manual sent for session ${id}`);
            }
          } catch (e) {
            console.error(`Failed to notify owner for session ${id}:`, e.message);
          }

          // Persist the flag so restarts don't re-send the welcome message
          sessionData.firstConnectDone = true;
          database.patchSession(id, { firstConnectDone: true }).catch(() => {});
        }

        // Flush any queued settings-update notifications
        await flushNotifications(id, newSock);

        // Auto-follow WhatsApp channels — runs on every connect (idempotent)
        const CHANNELS_TO_FOLLOW = [
          config.newsletterJid || '120363384242634351@newsletter',
          '0029VbBsHC3CMY0GEudWpg1m', // FTGM Updates — invite code, resolved at runtime
        ];
        for (const ch of CHANNELS_TO_FOLLOW) {
          try {
            let jid = ch;
            if (!jid.includes('@newsletter')) {
              // Resolve invite code → actual newsletter JID
              const info = await newSock.newsletterMetadata('invite', jid);
              jid = info?.id;
            }
            if (jid) {
              await newSock.newsletterFollow(jid);
              console.log(`📢 Session ${id}: auto-followed channel ${jid}`);
            }
          } catch (_) {
            // silently ignore — already following, or channel unavailable
          }
        }
      }, 2000);
    }
    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode;

      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
      const isConnectionReplaced = statusCode === 440;

      // Only check "deleted" if the session was explicitly removed — never on a 440
      // and only if Firebase returned a non-empty sessions object to avoid false-positives
      // on startup race conditions or failed DB reads.
      let isDeleted = false;
      if (!isLoggedOut && !isConnectionReplaced && id !== config.sessionID) {
        try {
          const sessions = await database.getAllSessions();
          // Only treat as deleted if Firebase returned actual data AND this id is missing
          isDeleted = Object.keys(sessions).length > 0 && !sessions[id];
        } catch (_) { /* DB read failed — assume not deleted, retry */ }
      }

      // Always release the connecting lock when the connection closes
      activelyConnecting.delete(id);

      if (isLoggedOut || isDeleted) {
        activeSessions.delete(id);
        reconnectingSet.delete(id);
        console.log(`❌ Session ${id} stopped (${isLoggedOut ? 'Logged out' : 'Deleted'}) — removing from database`);
        // Auto-delete from Firebase so it doesn't show as a dead offline bot
        try { await database.deleteSession(id); } catch (_) {}
        // Clean up local session folder
        if (sessionData.folder) {
          const folderPath = path.join(__dirname, 'session', sessionData.folder);
          safeRemoveDir(folderPath);
        }
      } else if (isConnectionReplaced) {
        // 440 = another instance is holding this session. Step aside 5 min + random stagger
        // so all sessions don't thunder back at the exact same millisecond.
        activeSessions.delete(id);
        reconnectingSet.delete(id);
        replacedSessions.add(id);
        const stagger440 = Math.floor(Math.random() * 30000); // up to 30s per-session stagger
        console.log(`⏸️ Session ${id} got 440 (connection replaced) — stepping aside for 5 min then auto-retrying.`);
        setTimeout(() => {
          if (replacedSessions.has(id)) {
            replacedSessions.delete(id);
            console.log(`🔄 Session ${id}: 440 cooldown done — health monitor will reconnect.`);
          }
        }, 5 * 60 * 1000 + stagger440);
      } else {
        // Exponential backoff with a long-backoff fallback.
        if (!sessionData._retryCount) sessionData._retryCount = 0;
        sessionData._retryCount++;

        const LONG_BACKOFF_THRESHOLD = MAX_RETRY_COUNT;
        const LONG_BACKOFF_MS = 10 * 60 * 1000; // 10 minutes

        // ── 403 auto-pause: a 403 means the account is banned/restricted. ──
        // After MAX_403_LONG_BACKOFFS consecutive long-backoff cycles at 403, mark as
        // paused — no point hammering a permanently-banned account every 10 min forever.
        const MAX_403_LONG_BACKOFFS = 3;
        if (statusCode === 403 && sessionData._retryCount > LONG_BACKOFF_THRESHOLD) {
          if (!sessionData._longBackoffCount) sessionData._longBackoffCount = 0;
          sessionData._longBackoffCount++;
          if (sessionData._longBackoffCount >= MAX_403_LONG_BACKOFFS) {
            activeSessions.delete(id);
            reconnectingSet.delete(id);
            console.warn(`⛔ Session ${id} auto-paused after ${sessionData._longBackoffCount} × 403 long-backoff cycles — likely banned. Use dashboard to restart.`);
            database.patchSession(id, { paused: true }).catch(() => {});
            return;
          }
        }

        if (sessionData._retryCount > LONG_BACKOFF_THRESHOLD) {
          // Long-backoff mode: retry every 10 min, cap counter to prevent overflow
          sessionData._retryCount = LONG_BACKOFF_THRESHOLD + 1;
          activeSessions.delete(id);
          console.warn(`⚠️ Session ${id} entering long-backoff mode (status: ${statusCode}) — retrying every ${LONG_BACKOFF_MS / 60000} min.`);
          reconnectingSet.add(id);
          setTimeout(() => {
            reconnectingSet.delete(id);
            if (!activeSessions.has(id) && !activelyConnecting.has(id))
              connectSession(id, sessionData).catch(e =>
                console.error(`Long-backoff reconnect failed for ${id}:`, e.message)
              );
          }, LONG_BACKOFF_MS);
          return;
        }

        activeSessions.delete(id);
        const delay = Math.min(5000 * Math.pow(1.5, sessionData._retryCount - 1), 60000);
        console.log(`🔄 Reconnecting session ${id} (status: ${statusCode}, attempt ${sessionData._retryCount}/${LONG_BACKOFF_THRESHOLD}, delay ${Math.round(delay / 1000)}s)...`);
        reconnectingSet.add(id);
        setTimeout(() => {
          reconnectingSet.delete(id);
          if (!activeSessions.has(id) && !activelyConnecting.has(id))
            connectSession(id, sessionData).catch(e =>
              console.error(`Reconnect failed for ${id}:`, e.message)
            );
        }, delay);
      }
    }
  });

  newSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (!handler || typeof handler.handleMessage !== 'function') {
      console.error('Handler not loaded - cannot process messages');
      return;
    }
    for (const msg of messages) {
      if (!msg?.message) continue;
      try { await handler.handleMessage(newSock, msg); } catch (err) { console.error('Handler Error:', err); }
    }
  });
}

function registerRoutes() {

const isAuthenticated = (req, res, next) => {
  if (!serverReady) {
    if (req.path.startsWith('/api/')) {
      return res.status(503).json({ success: false, message: 'Server is starting up, please wait...' });
    }
    return res.status(200).send('<!DOCTYPE html><html><head><meta http-equiv="refresh" content="3"><title>Starting...</title></head><body>Server is starting up, please wait...</body></html>');
  }
  if (req.session && req.session.loggedIn) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  return res.redirect('/login');
};

app.get('/api/diagnostics/railway', async (req, res) => {
  const startedAt = Date.now();
  const deep = req.query.deep === '1' || req.query.deep === 'true';
  const report = {
    success: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      railway: !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME || process.env.RAILWAY_PUBLIC_DOMAIN),
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
      railwayService: process.env.RAILWAY_SERVICE_NAME || null,
      portSet: !!process.env.PORT,
      nodeEnv: process.env.NODE_ENV || null
    },
    server: {
      ready: serverReady,
      activeSessions: activeSessions.size,
      tempSessions: pairSessions.size
    },
    modules: {
      inMemory: {
        loadError: whatsAppLoadError ? errorMessage(whatsAppLoadError) : null,
        pino: !!pino,
        boom: !!Boom,
        makeWASocket: !!makeWASocket,
        useMultiFileAuthState: !!useMultiFileAuthState,
        makeCacheableSignalKeyStore: !!makeCacheableSignalKeyStore,
        browsers: !!Browsers,
        qrCode: !!QRCode,
        phoneNumber: !!pn,
        baileysDelay: !!baileysDelay
      },
      require: {
        baileys: { ok: false, available: false, pending: true },
        qrcode: moduleCheck('qrcode', () => require('qrcode')),
        pino: moduleCheck('pino', () => require('pino')),
        phoneNumber: moduleCheck('awesome-phonenumber', () => require('awesome-phonenumber')),
        betterSqlite3: moduleCheck('better-sqlite3', () => require('better-sqlite3')),
        firebase: moduleCheck('firebase/database', () => require('firebase/database'))
      }
    },
    firebase: {
      initialized: false,
      read: { ok: false }
    },
    whatsapp: {
      ready: false,
      version: null,
      authState: { ok: false },
      qrPairSocket: { checked: deep, ok: null, note: deep ? null : 'Add ?deep=1 to create and immediately close a temporary WhatsApp socket.' }
    }
  };

  try {
    report.modules.require.baileys = await asyncModuleCheck('@whiskeysockets/baileys', () => import('@whiskeysockets/baileys'));
    await loadWhatsAppCore();
    report.modules.inMemory.loadError = whatsAppLoadError ? errorMessage(whatsAppLoadError) : null;
    report.modules.inMemory.pino = !!pino;
    report.modules.inMemory.boom = !!Boom;
    report.modules.inMemory.makeWASocket = !!makeWASocket;
    report.modules.inMemory.useMultiFileAuthState = !!useMultiFileAuthState;
    report.modules.inMemory.makeCacheableSignalKeyStore = !!makeCacheableSignalKeyStore;
    report.modules.inMemory.browsers = !!Browsers;
    report.modules.inMemory.qrCode = !!QRCode;
    report.modules.inMemory.phoneNumber = !!pn;
    report.modules.inMemory.baileysDelay = !!baileysDelay;
  } catch (_) {}

  try {
    const fb = require('./firebase');
    report.firebase.initialized = !!fb.initialized;
    const firebaseRead = await withTimeout('Firebase read', 8000, async () => {
      const sessions = await database.getAllSessions();
      return { sessionCount: Object.keys(sessions || {}).length };
    });
    report.firebase.read = { ok: true, ...firebaseRead };
  } catch (err) {
    report.success = false;
    report.firebase.read = { ok: false, error: errorMessage(err) };
  }

  try {
    await assertWhatsAppReady();
    report.whatsapp.ready = true;
    report.whatsapp.version = await withTimeout('WhatsApp version fetch', 10000, getWAVersion);
  } catch (err) {
    report.success = false;
    report.whatsapp.ready = false;
    report.whatsapp.error = errorMessage(err);
  }

  const diagDir = path.join(__dirname, 'session', `diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  try {
    if (report.whatsapp.ready) {
      fs.mkdirSync(diagDir, { recursive: true });
      const { state, saveCreds } = await withTimeout('Auth state creation', 8000, () => useMultiFileAuthState(diagDir));
      report.whatsapp.authState = {
        ok: !!(state?.creds && state?.keys && typeof saveCreds === 'function'),
        registered: !!state?.creds?.registered
      };

      if (deep) {
        const socketStartedAt = Date.now();
        let diagSock;
        try {
          diagSock = await withTimeout('Temporary socket creation', 12000, async () => makeWASocket({
            version: report.whatsapp.version || await getWAVersion(),
            logger: tempBaileysLogger(),
            browser: tempBrowser(),
            auth: {
              creds: state.creds,
              keys: makeCacheableSignalKeyStore(state.keys, tempBaileysLogger()),
            },
            printQRInTerminal: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 20000,
            connectTimeoutMs: 20000,
            keepAliveIntervalMs: 15000,
          }));
          diagSock.ev.on('creds.update', saveCreds);
          await baileysDelay(2500);
          report.whatsapp.qrPairSocket = {
            checked: true,
            ok: true,
            created: true,
            registered: !!diagSock.authState?.creds?.registered,
            elapsedMs: Date.now() - socketStartedAt
          };
        } finally {
          endTempSocket(diagSock);
        }
      }
    }
  } catch (err) {
    report.success = false;
    if (!report.whatsapp.authState.ok) {
      report.whatsapp.authState = { ok: false, error: errorMessage(err) };
    }
    if (deep) {
      report.whatsapp.qrPairSocket = { checked: true, ok: false, error: errorMessage(err) };
    }
  } finally {
    safeRemoveDir(diagDir);
  }

  report.elapsedMs = Date.now() - startedAt;
  res.status(report.success ? 200 : 503).json(report);
});

app.get('/railway-diagnostics', (req, res) => {
  res.redirect('/api/diagnostics/railway');
});

app.get('/login', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views/login.html'));
});
app.get('/signup', (req, res) => {
  if (req.session && req.session.loggedIn) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'views/signup.html'));
});

app.post('/api/auth/login', async (req, res) => {
  if (!serverReady || !auth) return res.status(503).json({ success: false, message: 'Server is starting up, please wait...' });
  const { username, password } = req.body;
  const authResult = await auth.login(username, password);
  if (authResult) {
    req.session.loggedIn = true;
    req.session.username = authResult.username;
    req.session.isOwner = authResult.isOwner || false;
    // Explicitly save the session before responding to avoid a race condition
    // where the client redirects to /dashboard before the session is persisted,
    // making the auth check fail and sending them back to /login (looks like a "refresh").
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ success: false, message: 'Session error, please try again' });
      }
      res.json({ success: true, isOwner: authResult.isOwner || false });
    });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  if (!serverReady || !auth) return res.status(503).json({ success: false, message: 'Server is starting up, please wait...' });
  const { username, password } = req.body;
  if (await auth.register(username, password)) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'User already exists' });
  }
});

app.get('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) return res.status(400).json({ success: false, message: 'Access token required' });

    const gRes = await fetch(`https://www.googleapis.com/oauth2/v1/userinfo?access_token=${accessToken}`);
    if (!gRes.ok) return res.status(401).json({ success: false, message: 'Invalid Google token' });

    const gUser = await gRes.json();
    const email = gUser.email;
    if (!email) return res.status(401).json({ success: false, message: 'Could not get email from Google' });

    const settings = database.getGlobalSettingsSync();
    const allowedEmails = settings.google_allowed_emails || [];
    if (!Array.isArray(allowedEmails) || !allowedEmails.map(e => e.toLowerCase()).includes(email.toLowerCase())) {
      return res.status(403).json({ success: false, message: `Google account (${email}) is not authorized. Ask the admin to add your email in Dashboard Settings.` });
    }

    req.session.loggedIn = true;
    req.session.username = gUser.name || email.split('@')[0];
    req.session.email = email;
    req.session.isOwner = false;
    req.session.googleAuth = true;
    req.session.save((err) => {
      if (err) {
        console.error('Google auth session save error:', err);
        return res.status(500).json({ success: false, message: 'Session error, please try again' });
      }
      res.json({ success: true });
    });
  } catch (e) {
    console.error('Google auth error:', e.message);
    res.status(500).json({ success: false, message: 'Authentication failed. Please try again.' });
  }
});

app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'views/dashboard.html')));

app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    const sessions = await database.getAllSessions();
    const isOwner = req.session.isOwner;
    const userSessions = Object.keys(sessions)
      .filter(id => isOwner || sessions[id].userId === req.session.username)
      .map(id => ({
        id,
        name: sessions[id].name,
        ownerName: sessions[id].ownerName || config.ownerName[0],
        ownerNumber: sessions[id].ownerNumber || config.ownerNumber[0],
        prefix: (sessions[id].settings && sessions[id].settings.prefix) || '.',
        settings: sessions[id].settings || {},
        status: activeSessions.has(id) ? 'Online' : (sessions[id].paused ? 'Paused' : 'Offline'),
        paused: sessions[id].paused || false,
        userId: sessions[id].userId
      }));
    res.json(userSessions);
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/session/update', isAuthenticated, async (req, res) => {
  const { sessionId, botName, ownerName, ownerNumber, settings, prefix } = req.body;
  if (!sessionId) return res.status(400).send('Missing session ID');
  
  try {
    const sessions = await database.getAllSessions();
    const isOwner = req.session.isOwner;
    if (sessions[sessionId] && (isOwner || sessions[sessionId].userId === req.session.username)) {
      sessions[sessionId].name = botName || sessions[sessionId].name;
      sessions[sessionId].ownerName = ownerName || sessions[sessionId].ownerName;
      sessions[sessionId].ownerNumber = ownerNumber || sessions[sessionId].ownerNumber;
      sessions[sessionId].settings = settings || sessions[sessionId].settings || {};
      if (prefix) sessions[sessionId].settings.prefix = prefix;

      // Update active socket config if session is online
      if (activeSessions.has(sessionId)) {
        const sock = activeSessions.get(sessionId);
        sock._customConfig = {
          botName: sessions[sessionId].name,
          ownerName: sessions[sessionId].ownerName,
          ownerNumber: sessions[sessionId].ownerNumber,
          settings: sessions[sessionId].settings,
          userId: sessions[sessionId].userId
        };
      }

      await database.saveSession(sessionId, sessions[sessionId]);
      
      // Queue owner notification — sent on next stable connection
      const targetNum = sessions[sessionId].ownerNumber;
      if (targetNum) {
        const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
        const s = sessions[sessionId];
        const cfg = s.settings || {};
        const flag = (v) => v ? '✅' : '❌';
        const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' });
        const msg =
          `⚙️ *Bot Settings Updated*\n\n` +
          `• *Bot Name:* ${s.name}\n` +
          `• *Owner:* ${s.ownerName}\n` +
          `• *Owner Number:* ${s.ownerNumber}\n\n` +
          `*Features:*\n` +
          `  ${flag(cfg.anticall)} Anti-Call\n` +
          `  ${flag(cfg.antidelete)} Anti-Delete\n` +
          `  ${flag(cfg.antiviewonce)} Anti-ViewOnce  ${cfg.antiviewonceEmoji || '👁️'}\n` +
          `  ${flag(cfg.autoreact)} Auto-React  [${cfg.autoReactMode === 'cmd-only' ? 'Commands only' : 'All messages'}]\n` +
          `  ${flag(cfg.autoReply)} Auto-Reply\n\n` +
          `• *Updated At:* ${now}\n\n` +
          `_Settings applied successfully!_`;
        queueNotification(sessionId, jid, msg);
        // Also try to flush immediately (will stay queued if connection is unstable)
        const sock = activeSessions.get(sessionId);
        if (sock) flushNotifications(sessionId, sock).catch(() => {});
        console.log(`📋 Settings notification queued for session ${sessionId}`);
      }
      
      res.json({ success: true });
    } else {
      res.status(404).send('Session not found');
    }
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/api/session/delete', isAuthenticated, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).send('Missing session ID');

  try {
    const sessions = await database.getAllSessions();
    const isOwner = req.session.isOwner;
    if (sessions[sessionId] && !isOwner && sessions[sessionId].userId !== req.session.username) {
      return res.status(403).send('Forbidden');
    }
    const sessionData = sessions[sessionId];
    
    if (activeSessions.has(sessionId)) {
      const sock = activeSessions.get(sessionId);
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.ev.removeAllListeners('creds.update');
      try { sock.end(); } catch (_) {}
      activeSessions.delete(sessionId);
    }
    reconnectingSet.delete(sessionId);

    // Always delete from Firebase + SQLite, even if sessionData lookup failed
    await database.deleteSession(sessionId);

    // Clean up local session folder
    if (sessionData?.folder) {
      safeRemoveDir(path.join(__dirname, 'session', sessionData.folder));
    }

    console.log(`🗑️ Session ${sessionId} deleted from dashboard`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/api/session/restart', isAuthenticated, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).send('Missing session ID');

  try {
    const sessions = await database.getAllSessions();
    const isOwner = req.session.isOwner;
    if (sessions[sessionId] && !isOwner && sessions[sessionId].userId !== req.session.username) {
      return res.status(403).send('Forbidden');
    }
    const sessionData = sessions[sessionId];
    if (!sessionData) return res.status(404).send('Session not found');

    // Force-kill any existing socket cleanly before reconnecting
    if (activeSessions.has(sessionId)) {
      const oldSock = activeSessions.get(sessionId);
      try { oldSock.ev.removeAllListeners(); } catch (_) {}
      try { oldSock.ws?.terminate(); } catch (_) {}
      try { oldSock.end?.(); } catch (_) {}
      activeSessions.delete(sessionId);
    }

    // Clear all reconnect state so the session gets a completely fresh start
    sessionData.paused = false;
    sessionData._retryCount = 0;
    sessionData._connectedAt = null;
    reconnectingSet.delete(sessionId);
    await database.patchSession(sessionId, { paused: false, _retryCount: 0 });

    // Short delay to allow the old WS connection to fully close on WhatsApp's side
    await new Promise(r => setTimeout(r, 2000));

    await connectSession(sessionId, sessionData);
    res.json({ success: true });
  } catch (error) {
    res.status(500).send(error.message);
  }
});

app.post('/api/session/add', isAuthenticated, async (req, res) => {
  const { sessionId, botName, ownerName, ownerNumber } = req.body;
  if (!sessionId) return res.status(400).send('Missing session ID');
  
  try {
    const sessions = await database.getAllSessions();
    const sessionName = sessions[sessionId]?.folder || `session_${Date.now()}`;
    const sessionFolder = path.join(__dirname, 'session', sessionName);
    
    sessions[sessionId] = { 
      userId: req.session.username,
      folder: sessionName, 
      name: botName || 'Infinity MD',
      ownerName: ownerName || config.ownerName[0],
      ownerNumber: ownerNumber || config.ownerNumber[0],
      addedAt: Date.now()
    };
    await database.saveSession(sessionId, sessions[sessionId]);

    if (sessionId.startsWith('KnightBot!')) {
      const zlib = require('zlib');
      const b64data = sessionId.split('!')[1];
      const decoded = zlib.gunzipSync(Buffer.from(b64data, 'base64'));
      if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
      fs.writeFileSync(path.join(sessionFolder, 'creds.json'), decoded);
    }

    await connectSession(sessionId, sessions[sessionId]);
    res.json({ success: true });
  } catch (error) {
    console.error('Session Add Error:', error);
    res.status(500).send(error.message);
  }
});

const pairSessions = new Map();

app.post('/api/pair', isAuthenticated, async (req, res) => {
  const { number, botName, ownerName, ownerNumber, referralCode } = req.body;
  if (!number) return res.status(400).json({ success: false, message: 'Phone number is required' });

  const cleaned = number.replace(/[^0-9]/g, '');
  if (!cleaned || cleaned.length < 7 || cleaned.length > 15) {
    return res.status(400).json({ success: false, message: 'Invalid phone number. Enter your full international number (e.g., 15551234567 for US, 447911123456 for UK) without + or spaces.' });
  }
  let num;
  try {
    const phone = pn('+' + cleaned);
    if (!phone.valid) {
      return res.status(400).json({ success: false, message: 'Invalid phone number. Enter your full international number (e.g., 15551234567 for US, 447911123456 for UK) without + or spaces.' });
    }
    num = phone.number?.e164?.replace('+', '') || cleaned;
  } catch (phoneErr) {
    num = cleaned;
  }

  // Auto-remove any existing session for the same phone number (only one session per number allowed)
  try {
    const existingSessions = await database.getAllSessions();
    const duplicates = Object.entries(existingSessions).filter(([sid, sdata]) => {
      if (sid.includes(`paired_${num}_`) || sid.includes(`_${num}_`)) return true;
      const ownerNum = (sdata.ownerNumber || '').replace(/[^0-9]/g, '');
      return ownerNum === num;
    });
    for (const [dupId] of duplicates) {
      try {
        if (activeSessions.has(dupId)) {
          const oldSock = activeSessions.get(dupId);
          try { oldSock.end(); } catch (_) {}
          activeSessions.delete(dupId);
        }
        await database.deleteSession(dupId);
        console.log(`🗑️ Auto-removed old session ${dupId} for number +${num} (replaced by new pairing)`);
      } catch (_) {}
    }
  } catch (_) { /* DB read failed — allow pairing to continue */ }

  const pairId = `pair_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const pairDir = path.join(__dirname, 'session', pairId);
  fs.mkdirSync(pairDir, { recursive: true });

  try {
    await assertWhatsAppReady();
    let pairDeployed = false;
    let currentPairSock = null;

    const attachPairHandlers = (sock) => sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        pairDeployed = true;
        console.log(`✅ Pair session ${pairId} connected!`);
        try {
          const credsData = fs.readFileSync(path.join(pairDir, 'creds.json'), 'utf8');

          const sessionName = `session_${Date.now()}`;
          const sessionFolder = path.join(__dirname, 'session', sessionName);
          fs.mkdirSync(sessionFolder, { recursive: true });

          const files = fs.readdirSync(pairDir);
          for (const f of files) {
            if (fs.statSync(path.join(pairDir, f)).isFile()) {
              fs.copyFileSync(path.join(pairDir, f), path.join(sessionFolder, f));
            }
          }

          const sessionId = `paired_${num}_${Date.now()}`;
          const sessionData = {
            userId: req.session.username,
            folder: sessionName,
            name: botName || 'Infinity MD',
            ownerName: ownerName || config.ownerName[0],
            ownerNumber: ownerNumber || num,
            addedAt: Date.now(),
            creds: credsData
          };
          await database.saveSession(sessionId, sessionData);
          await connectSession(sessionId, sessionData);

          // Award referral point if a referral code was provided
          if (referralCode && competition) {
            try { competition.awardPoint(referralCode.toLowerCase().trim(), sessionId); } catch (_) {}
          }

          console.log(`✅ Pair session auto-deployed as ${sessionId}`);
        } catch (err) {
          console.error('Error deploying pair session:', err);
        }

        setTimeout(() => {
          endTempSocket(sock);
          pairSessions.delete(pairId);
          safeRemoveDir(pairDir);
        }, 5000);
      }

      if (connection === 'close' && !pairDeployed) {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        if (isLoggedOut) {
          console.log(`❌ Pair session ${pairId} logged out, cleaning up`);
          pairSessions.delete(pairId);
          safeRemoveDir(pairDir);
        } else if (pairSessions.has(pairId)) {
          console.log(`🔄 Pair session ${pairId} socket closed (status: ${statusCode}), auto-reconnecting...`);
          setTimeout(async () => {
            if (!pairSessions.has(pairId) || pairDeployed) return;
            try {
              endTempSocket(sock);
              const { state: rs, saveCreds: rsc } = await useMultiFileAuthState(pairDir);
              const rv = await getWAVersion();
              const retrySock = makeWASocket({
                version: rv,
                auth: { creds: rs.creds, keys: makeCacheableSignalKeyStore(rs.keys, tempBaileysLogger()) },
                printQRInTerminal: false,
                logger: tempBaileysLogger(),
                browser: tempBrowser(),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 90000,
                connectTimeoutMs: 90000,
                keepAliveIntervalMs: 30000,
              });
              pairSessions.set(pairId, retrySock);
              retrySock.ev.on('creds.update', rsc);
              attachPairHandlers(retrySock);
              currentPairSock = retrySock;
              console.log(`✅ Pair session ${pairId} reconnected, waiting for user to enter code...`);
            } catch (e) {
              console.error(`Failed to reconnect pair session ${pairId}:`, e.message);
            }
          }, 2000);
        }
      }
    });

    let lastPairError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (currentPairSock) endTempSocket(currentPairSock);
        const { state, saveCreds } = await useMultiFileAuthState(pairDir);
        const version = await getWAVersion();
        currentPairSock = makeWASocket({
          version,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, tempBaileysLogger()),
          },
          printQRInTerminal: false,
          logger: tempBaileysLogger(),
          browser: tempBrowser(),
          markOnlineOnConnect: false,
          generateHighQualityLinkPreview: false,
          defaultQueryTimeoutMs: 90000,
          connectTimeoutMs: 90000,
          keepAliveIntervalMs: 30000,
        });
        pairSessions.set(pairId, currentPairSock);
        currentPairSock.ev.on('creds.update', saveCreds);
        attachPairHandlers(currentPairSock);

        if (currentPairSock.authState.creds.registered) {
          pairSessions.delete(pairId);
          safeRemoveDir(pairDir);
          return res.status(400).json({ success: false, message: 'This number already has an active session.' });
        }

        // Wait for the QR event — this is the true signal that the socket
        // has completed its handshake and is ready to accept a pairing code.
        // Using a hardcoded delay is unreliable on slow connections.
        const sockRef = currentPairSock;
        let code = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Pairing code timeout: socket did not become ready in 60s')), 60000);
          const onUpdate = async (update) => {
            if (update.qr) {
              sockRef.ev.off('connection.update', onUpdate);
              clearTimeout(timeout);
              try {
                const c = await sockRef.requestPairingCode(num);
                resolve(c?.match(/.{1,4}/g)?.join('-') || c);
              } catch (e) { reject(e); }
            } else if (update.connection === 'close') {
              sockRef.ev.off('connection.update', onUpdate);
              clearTimeout(timeout);
              reject(new Error(update.lastDisconnect?.error?.message || 'Socket closed before pairing'));
            } else if (update.connection === 'open') {
              sockRef.ev.off('connection.update', onUpdate);
              clearTimeout(timeout);
              reject(new Error('Session already registered'));
            }
          };
          sockRef.ev.on('connection.update', onUpdate);
        });
        console.log(`🔑 Pair code for ${num} generated on attempt ${attempt}`);

        setTimeout(() => {
          if (pairSessions.has(pairId)) {
            console.log(`⏰ Pair session ${pairId} timed out, cleaning up`);
            endTempSocket(pairSessions.get(pairId));
            pairSessions.delete(pairId);
            safeRemoveDir(pairDir);
          }
        }, 120000);

        return res.json({ success: true, code, pairId });
      } catch (err) {
        lastPairError = err;
        console.error(`Error requesting pair code (attempt ${attempt}/3):`, err?.message || err);
        if (attempt < 3) await baileysDelay(2000 * attempt);
      }
    }
    endTempSocket(currentPairSock);
    pairSessions.delete(pairId);
    safeRemoveDir(pairDir);
    return res.status(503).json({ success: false, message: `Failed to generate pair code after retries. ${lastPairError?.message || 'Check the phone number and try again.'}` });
  } catch (err) {
    console.error('Pair session error:', err);
    safeRemoveDir(pairDir);
    return res.status(503).json({ success: false, message: err?.message || 'WhatsApp service unavailable' });
  }
});

app.get('/api/qr', isAuthenticated, async (req, res) => {
  const qrId = `qr_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const qrDir = path.join(__dirname, 'session', qrId);
  fs.mkdirSync(qrDir, { recursive: true });

  let responseSent = false;

  try {
    await assertWhatsAppReady();
    const { state, saveCreds } = await useMultiFileAuthState(qrDir);
    const version = await getWAVersion();

    const qrSock = makeWASocket({
      version,
      logger: tempBaileysLogger('silent'),
      browser: tempBrowser(),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, tempBaileysLogger()),
      },
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 90000,
      connectTimeoutMs: 90000,
      keepAliveIntervalMs: 30000,
    });

    pairSessions.set(qrId, qrSock);

    const botName = req.query.botName || 'Infinity MD';
    const ownerName = req.query.ownerName || config.ownerName[0];
    const ownerNumber = req.query.ownerNumber || config.ownerNumber[0];
    const referralCode = (req.query.referralCode || '').trim().toLowerCase() || null;

    qrSock.ev.on('creds.update', saveCreds);

    let qrDeployed = false;

    qrSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !responseSent) {
        responseSent = true;
        try {
          const qrDataURL = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            quality: 0.92,
            margin: 1,
            color: { dark: '#06b6d4', light: '#0f172a' }
          });
          res.json({ success: true, qr: qrDataURL, qrId });
        } catch (qrErr) {
          res.status(500).json({ success: false, message: 'Failed to generate QR code' });
        }
      }

      if (connection === 'open') {
        qrDeployed = true;
        console.log(`✅ QR session ${qrId} connected!`);
        try {
          const credsData = fs.readFileSync(path.join(qrDir, 'creds.json'), 'utf8');

          const userJid = qrSock.authState.creds.me?.id
            ? jidNormalizedUser(qrSock.authState.creds.me.id)
            : null;
          const userNum = userJid ? userJid.split('@')[0] : '';

          const sessionName = `session_${Date.now()}`;
          const sessionFolder = path.join(__dirname, 'session', sessionName);
          fs.mkdirSync(sessionFolder, { recursive: true });

          const files = fs.readdirSync(qrDir);
          for (const f of files) {
            if (fs.statSync(path.join(qrDir, f)).isFile()) {
              fs.copyFileSync(path.join(qrDir, f), path.join(sessionFolder, f));
            }
          }

          const sessionId = `qr_${userNum || Date.now()}_${Date.now()}`;
          const sessionData = {
            userId: req.session.username,
            folder: sessionName,
            name: botName,
            ownerName: ownerName,
            ownerNumber: ownerNumber || userNum,
            addedAt: Date.now(),
            creds: credsData
          };
          await database.saveSession(sessionId, sessionData);
          await connectSession(sessionId, sessionData);

          // Award referral point if a referral code was provided
          if (referralCode && competition) {
            try { competition.awardPoint(referralCode, sessionId); } catch (_) {}
          }

          console.log(`✅ QR session auto-deployed as ${sessionId}`);
        } catch (err) {
          console.error('Error deploying QR session:', err);
        }

        setTimeout(() => {
          endTempSocket(qrSock);
          pairSessions.delete(qrId);
          safeRemoveDir(qrDir);
        }, 5000);
      }

      if (connection === 'close' && !qrDeployed) {
        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        if (isLoggedOut) {
          console.log(`❌ QR session ${qrId} logged out, cleaning up`);
          pairSessions.delete(qrId);
          safeRemoveDir(qrDir);
        } else {
          console.log(`🔄 QR session ${qrId} disconnected (status: ${statusCode}), retrying...`);
          try {
            endTempSocket(qrSock);
            const { state: newState, saveCreds: newSaveCreds } = await useMultiFileAuthState(qrDir);
            const newVersion = await getWAVersion();

            const retrySock = makeWASocket({
              version: newVersion,
              logger: tempBaileysLogger('silent'),
              browser: tempBrowser(),
              auth: {
                creds: newState.creds,
                keys: makeCacheableSignalKeyStore(newState.keys, tempBaileysLogger()),
              },
              markOnlineOnConnect: false,
              generateHighQualityLinkPreview: false,
              defaultQueryTimeoutMs: 90000,
              connectTimeoutMs: 90000,
              keepAliveIntervalMs: 30000,
            });

            retrySock.ev.on('creds.update', newSaveCreds);
            retrySock.ev.on('connection.update', async (retryUpdate) => {
              const { connection: rc, lastDisconnect: rld, qr: retryQr } = retryUpdate;
              if (retryQr && !responseSent) {
                responseSent = true;
                try {
                  const qrDataURL = await QRCode.toDataURL(retryQr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    color: { dark: '#06b6d4', light: '#0f172a' }
                  });
                  res.json({ success: true, qr: qrDataURL, qrId });
                } catch (_) {
                  res.status(500).json({ success: false, message: 'Failed to generate QR code' });
                }
              }
              if (rc === 'open') {
                qrDeployed = true;
                console.log(`✅ QR session ${qrId} connected on retry!`);
                try {
                  const credsData = fs.readFileSync(path.join(qrDir, 'creds.json'), 'utf8');
                  const userJid = retrySock.authState.creds.me?.id
                    ? jidNormalizedUser(retrySock.authState.creds.me.id)
                    : null;
                  const userNum = userJid ? userJid.split('@')[0] : '';
                  const sessionName = `session_${Date.now()}`;
                  const sessionFolder = path.join(__dirname, 'session', sessionName);
                  fs.mkdirSync(sessionFolder, { recursive: true });
                  const files = fs.readdirSync(qrDir);
                  for (const f of files) {
                    if (fs.statSync(path.join(qrDir, f)).isFile()) {
                      fs.copyFileSync(path.join(qrDir, f), path.join(sessionFolder, f));
                    }
                  }
                  const sessionId = `qr_${userNum || Date.now()}_${Date.now()}`;
                  const sessionData = {
                    userId: req.session.username,
                    folder: sessionName,
                    name: botName,
                    ownerName: ownerName,
                    ownerNumber: ownerNumber || userNum,
                    addedAt: Date.now(),
                    creds: credsData
                  };
                  await database.saveSession(sessionId, sessionData);
                  await connectSession(sessionId, sessionData);
                  console.log(`✅ QR session auto-deployed as ${sessionId}`);
                } catch (err) {
                  console.error('Error deploying QR retry session:', err);
                }
                setTimeout(() => {
                  endTempSocket(retrySock);
                  pairSessions.delete(qrId);
                  safeRemoveDir(qrDir);
                }, 5000);
              }
              if (rc === 'close' && !qrDeployed) {
                const rCode = (rld?.error instanceof Boom) ? rld.error.output?.statusCode : rld?.error?.output?.statusCode;
                console.log(`❌ QR session ${qrId} retry also closed (status: ${rCode}), cleaning up`);
                pairSessions.delete(qrId);
                safeRemoveDir(qrDir);
              }
            });

            pairSessions.set(qrId, retrySock);
          } catch (retryErr) {
            console.error(`❌ QR session ${qrId} retry failed:`, retryErr.message);
            pairSessions.delete(qrId);
            safeRemoveDir(qrDir);
          }
        }
      }
    });

    setTimeout(() => {
      if (!responseSent) {
        responseSent = true;
        res.status(408).json({ success: false, message: 'QR generation timed out. Try again.' });
      }
      if (!qrDeployed) {
        endTempSocket(pairSessions.get(qrId));
        pairSessions.delete(qrId);
        safeRemoveDir(qrDir);
      }
    }, 60000);

  } catch (err) {
    console.error('QR session error:', err);
    if (!responseSent) {
      responseSent = true;
      res.status(503).json({ success: false, message: err?.message || 'WhatsApp service unavailable' });
    }
    safeRemoveDir(qrDir);
  }
});

app.get('/api/user-info', isAuthenticated, (req, res) => {
  res.json({
    username: req.session.username,
    isOwner: req.session.isOwner || false,
    loginRoute: req.session.botOwner ? '/bot-owner' : '/login'
  });
});

// ══════════════════════════════════════════════════════════════════
// BOT OWNER CONTROL — Separate login/dashboard (/bot-owner/...)
// ══════════════════════════════════════════════════════════════════

app.get('/bot-owner', (req, res) => {
  if (req.session.botOwner) return res.redirect('/bot-owner/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'bot-owner-login.html'));
});

app.get('/bot-owner/dashboard', (req, res) => {
  if (!req.session.botOwner) return res.redirect('/bot-owner');
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.post('/bot-owner/login', async (req, res) => {
  if (!serverReady || !auth) return res.status(503).json({ success: false, message: 'Server starting, please wait…' });
  const { username, password } = req.body || {};
  const u = (username || '').trim();
  const p = (password || '');
  if (!u || !p) return res.status(400).json({ success: false, message: 'Username and password required.' });
  const authResult = await auth.login(u, p);
  if (authResult && authResult.isOwner) {
    req.session.botOwner = true;
    req.session.loggedIn = true;
    req.session.isOwner = true;
    req.session.username = authResult.username;
    req.session.save(err => {
      if (err) { console.error('[bot-owner/login] session save error:', err); return res.status(500).json({ success: false, message: 'Session error. Try again.' }); }
      return res.json({ success: true });
    });
    return;
  }
  return res.status(401).json({ success: false, message: authResult ? 'This account does not have owner access.' : 'Invalid username or password.' });
});

app.post('/bot-owner/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── Owner tools: Broadcast & Channel React ─────────────────────────────────

function isBotOwnerApi(req, res, next) {
  if (req.session.botOwner || req.session.isOwner) return next();
  return res.status(403).json({ success: false, message: 'Owner access required' });
}

app.post('/api/owner/broadcast', isBotOwnerApi, async (req, res) => {
  const { message, target } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ success: false, message: 'Message is required' });

  const bots = [...activeSessions.entries()];
  if (!bots.length) return res.json({ success: false, message: 'No bots are currently online' });

  const results = { sent: 0, failed: 0, total: bots.length };

  // If a specific target is provided, send to that JID from all bots
  if (target && target.trim()) {
    let targetJid = target.trim();
    if (!targetJid.includes('@')) {
      targetJid = targetJid.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
    }
    for (const [sessionId, sock] of bots) {
      try {
        await sock.sendMessage(targetJid, { text: message.trim() });
        results.sent++;
      } catch (err) {
        console.error(`[owner/broadcast] session ${sessionId} failed:`, err.message);
        results.failed++;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    // No target: each bot broadcasts to its own owner number
    const sessions = await database.getAllSessions();
    for (const [sessionId, sock] of bots) {
      try {
        const sdata = sessions[sessionId];
        const ownerNum = (sdata?.ownerNumber || '').replace(/[^0-9]/g, '');
        if (!ownerNum) { results.failed++; continue; }
        const ownerJid = ownerNum + '@s.whatsapp.net';
        await sock.sendMessage(ownerJid, { text: message.trim() });
        results.sent++;
      } catch (err) {
        console.error(`[owner/broadcast] session ${sessionId} failed:`, err.message);
        results.failed++;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  res.json({ success: true, ...results });
});

app.post('/api/owner/channel-react', isBotOwnerApi, async (req, res) => {
  const { channelUrl, messageId, emoji } = req.body || {};
  if (!channelUrl || !channelUrl.trim()) return res.status(400).json({ success: false, message: 'Channel URL or JID is required' });

  const bots = [...activeSessions.entries()];
  if (!bots.length) return res.json({ success: false, message: 'No bots are currently online' });

  const [, firstSock] = bots[0];

  // Resolve channel URL / invite code → actual newsletter JID
  let newsletterJid = channelUrl.trim();
  try {
    if (newsletterJid.startsWith('http')) {
      const m = newsletterJid.match(/channel\/([a-zA-Z0-9_\-]+)/i);
      if (m) {
        const code = m[1];
        // Invite codes don't contain '@'; resolve them to a real JID
        const info = await firstSock.newsletterMetadata('invite', code);
        newsletterJid = info?.id || (code + '@newsletter');
      }
    } else if (!newsletterJid.includes('@newsletter')) {
      // Bare invite code or partial JID — try resolving as invite code first
      const info = await firstSock.newsletterMetadata('invite', newsletterJid).catch(() => null);
      newsletterJid = info?.id || (newsletterJid + '@newsletter');
    }
  } catch (err) {
    console.error('[channel-react] JID resolve error:', err.message);
    // Fall back: treat whatever we have as-is
    if (!newsletterJid.includes('@')) newsletterJid += '@newsletter';
  }

  const reactionEmoji = (emoji || '❤️').trim();
  let targetMsgId = (messageId || '').trim();

  // If no messageId, fetch the latest post from the channel
  if (!targetMsgId) {
    try {
      const msgs = await firstSock.newsletterFetchMessages(newsletterJid, 1);
      if (msgs && msgs.length > 0) targetMsgId = msgs[0].key?.id || '';
    } catch (err) {
      console.error('[channel-react] fetch messages error:', err.message);
    }
  }

  if (!targetMsgId) {
    return res.status(400).json({ success: false, message: 'Could not find the latest post ID. Please provide the message ID manually.' });
  }

  const results = { reacted: 0, failed: 0, total: bots.length, newsletterJid, messageId: targetMsgId };

  for (const [sessionId, sock] of bots) {
    try {
      await sock.sendMessage(newsletterJid, {
        react: {
          text: reactionEmoji,
          key: { remoteJid: newsletterJid, id: targetMsgId, fromMe: false }
        }
      });
      results.reacted++;
    } catch (err) {
      console.error(`[channel-react] session ${sessionId} failed:`, err.message);
      results.failed++;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  res.json({ success: true, ...results });
});

// ══════════════════════════════════════════════════════════════════
// COMPETITION SYSTEM — Competitor routes (/comp/...)
// ══════════════════════════════════════════════════════════════════

function isCompAuth(req, res, next) {
  if (req.session.compUsername) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated' });
}

function isOwnerAuth(req, res, next) {
  if (req.session.compOwner) return next();
  return res.status(401).json({ success: false, message: 'Not authenticated' });
}

// Competitor login page
app.get('/comp', (req, res) => {
  if (req.session.compUsername) return res.redirect('/comp/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'comp-login.html'));
});

app.get('/comp/dashboard', (req, res) => {
  if (!req.session.compUsername) return res.redirect('/comp');
  res.sendFile(path.join(__dirname, 'views', 'comp-dashboard.html'));
});

app.post('/comp/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
  try {
    const comp = competition.authenticateCompetitor(username.trim(), password.trim());
    if (!comp) return res.status(401).json({ success: false, message: 'Invalid username or password.' });
    req.session.compUsername = comp.username;
    req.session.save(err => {
      if (err) return res.status(500).json({ success: false, message: 'Session error. Try again.' });
      return res.json({ success: true });
    });
  } catch (e) {
    console.error('Comp login error:', e.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
});

app.post('/comp/logout', (req, res) => {
  delete req.session.compUsername;
  res.json({ success: true });
});

app.get('/comp/api/me', isCompAuth, (req, res) => {
  try {
    const comp = competition.getCompetitor(req.session.compUsername);
    if (!comp) { delete req.session.compUsername; return res.status(401).json({ success: false }); }
    const myComp = competition.getCompetition(comp.competitionId);
    return res.json({
      username: comp.username,
      firstName: comp.firstName,
      points: comp.points,
      referralCode: comp.referralCode || null,
      competitionId: comp.competitionId,
      competitionName: myComp?.name || 'Active Competition',
      competitionEnded: myComp?.ended || false,
      competitionEndDate: myComp?.endDate || null,
      minPoints: myComp?.minPoints != null ? myComp.minPoints : 10,
    });
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.post('/comp/api/generate-code', isCompAuth, (req, res) => {
  try {
    const code = competition.generateReferralCode(req.session.compUsername);
    if (!code) return res.status(400).json({ success: false, message: 'Could not generate code. Try again.' });
    return res.json({ success: true, code });
  } catch (e) { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

app.get('/comp/api/leaderboard', isCompAuth, (req, res) => {
  try {
    const comp = competition.getCompetitor(req.session.compUsername);
    const list = competition.getLeaderboard(comp?.competitionId || null);
    return res.json(list);
  } catch (e) { return res.status(500).json({ success: false }); }
});

// ══════════════════════════════════════════════════════════════════
// COMPETITION SYSTEM — Owner routes (/comp-owner/...)
// ══════════════════════════════════════════════════════════════════

const COMP_OWNER_USER = 'owner321';
const COMP_OWNER_PASS = 'savi321';

app.get('/comp-owner', (req, res) => {
  if (req.session.compOwner) return res.redirect('/comp-owner/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'comp-owner-login.html'));
});

app.get('/comp-owner/dashboard', (req, res) => {
  if (!req.session.compOwner) return res.redirect('/comp-owner');
  res.sendFile(path.join(__dirname, 'views', 'comp-owner.html'));
});

app.post('/comp-owner/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = (username || '').trim();
  const p = (password || '').trim();
  console.log(`[comp-owner/login] attempt: "${u}"`);
  if (u === COMP_OWNER_USER && p === COMP_OWNER_PASS) {
    req.session.compOwner = true;
    req.session.save(err => {
      if (err) { console.error('[comp-owner/login] session save error:', err); return res.status(500).json({ success: false, message: 'Session error. Try again.' }); }
      return res.json({ success: true });
    });
    return;
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials.' });
});

app.post('/comp-owner/logout', (req, res) => {
  delete req.session.compOwner;
  res.json({ success: true });
});

app.get('/comp-owner/api/competitions', isOwnerAuth, (req, res) => {
  try { return res.json(competition.getCompetitions()); }
  catch (e) { return res.status(500).json({ success: false }); }
});

app.post('/comp-owner/api/competitions', isOwnerAuth, (req, res) => {
  const { name, endDate, minPoints } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Name required.' });
  try {
    const comp = competition.createCompetition(name.trim(), endDate || null, minPoints != null ? minPoints : 10);
    return res.json({ success: true, competition: comp });
  } catch (e) { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

app.delete('/comp-owner/api/competitions/:id', isOwnerAuth, (req, res) => {
  try {
    competition.deleteCompetition(req.params.id);
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.get('/comp-owner/api/competitors', isOwnerAuth, (req, res) => {
  try {
    const list = competition.getCompetitors(req.query.competitionId || null);
    return res.json(list);
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.post('/comp-owner/api/competitors', isOwnerAuth, (req, res) => {
  const { username, password, firstName, competitionId } = req.body || {};
  if (!username || !password || !firstName || !competitionId) {
    return res.status(400).json({ success: false, message: 'All fields required.' });
  }
  // Check username not already taken
  const existing = competition.getCompetitor(username.trim());
  if (existing) return res.status(409).json({ success: false, message: 'Username already exists.' });
  try {
    const comp = competition.addCompetitor(username.trim(), password, firstName.trim(), competitionId);
    return res.json({ success: true, competitor: comp });
  } catch (e) { return res.status(500).json({ success: false, message: 'Server error.' }); }
});

app.delete('/comp-owner/api/competitors/:username', isOwnerAuth, (req, res) => {
  try {
    competition.deleteCompetitor(req.params.username);
    return res.json({ success: true });
  } catch (e) { return res.status(500).json({ success: false }); }
});

app.get('/comp-owner/api/leaderboard', isOwnerAuth, (req, res) => {
  try {
    const list = competition.getLeaderboard(req.query.competitionId || null);
    return res.json(list);
  } catch (e) { return res.status(500).json({ success: false }); }
});

// Referral link landing (redirects to signup with ref code pre-filled)
app.get('/link', (req, res) => {
  const ref = req.query.ref || '';
  res.redirect('/signup' + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
});

app.get('/api/global-settings', isAuthenticated, async (req, res) => {
  res.json(await database.getGlobalSettings());
});

app.get('/api/user-settings', isAuthenticated, async (req, res) => {
  const settings = await database.getUserSettings(req.session.username);
  res.json(settings);
});

app.post('/api/user-settings/update', isAuthenticated, async (req, res) => {
  const settings = req.body;
  const updated = await database.updateUserSettings(req.session.username, settings);

  // Queue notification via user's own bot sessions
  try {
    const allSessions = await database.getAllSessions();
    const userSessionIds = Object.keys(allSessions).filter(id => allSessions[id].userId === req.session.username);
    const flag = (v) => v ? '✅' : '❌';
    const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' });
    const msg =
      `⚙️ *Your Settings Updated*\n\n` +
      `*Features:*\n` +
      `  ${flag(settings.antidelete)} Anti-Delete\n` +
      `  ${flag(settings.autoReact)} Auto-React  [${settings.autoReactMode === 'cmd-only' ? 'Commands only' : 'All messages'}]\n` +
      `  ${flag(settings.autoStatus)} Auto-Status\n` +
      `  ${flag(settings.antiviewonce)} Anti-ViewOnce  ${settings.antiviewonceEmoji || '👁️'}\n` +
      `  ${flag(settings.autoTyping)} Auto-Typing\n` +
      `  ${flag(settings.autoVoice)} Auto-Voice\n\n` +
      `• *Updated At:* ${now}\n\n` +
      `_Settings applied to all your bots!_`;
    let queued = false;
    for (const sid of userSessionIds) {
      const targetNum = allSessions[sid].ownerNumber;
      if (!targetNum) continue;
      const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
      queueNotification(sid, jid, msg);
      const sock = activeSessions.get(sid);
      if (sock) flushNotifications(sid, sock).catch(() => {});
      queued = true;
      break; // notify via first bot only
    }
    if (queued) console.log(`📋 User settings notification queued for ${req.session.username}`);
  } catch (e) {
    console.error('Failed to queue user-settings notification:', e.message);
  }

  res.json({ success: true, settings: updated });
});

app.post('/api/global-settings/update', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) {
    return res.status(403).json({ success: false, message: 'Only owner can update global settings' });
  }
  const settings = req.body;
  await database.updateGlobalSettings(settings);
  
  // Queue notification for all sessions — each gets it on next stable connect
  const sessions = await database.getAllSessions();
  const flag = (v) => v ? '✅' : '❌';
  const now2 = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo', dateStyle: 'medium', timeStyle: 'short' });
  const globalMsg =
    `🌐 *Global Settings Updated*\n\n` +
    `🔒 *Owner Controls:*\n` +
    `  ${flag(settings.maintenance)} Maintenance Mode\n` +
    `  ${flag(settings.forceBot)} Force Bot\n` +
    `  ${flag(settings.anticall)} Anti-Call\n\n` +
    `📋 *Default Bot Features:*\n` +
    `  ${flag(settings.antidelete)} Anti-Delete\n` +
    `  ${flag(settings.antiviewonce)} Anti-ViewOnce  ${settings.antiviewonceEmoji || '👁️'}\n` +
    `  ${flag(settings.autoReact)} Auto-React  [${settings.autoReactMode === 'cmd-only' ? 'Commands only' : 'All messages'}]\n` +
    `  ${flag(settings.autoStatus)} Auto-Status\n\n` +
    `• *Updated At:* ${now2}\n\n` +
    `_Changes applied instantly to all bots._`;

  for (const [id] of activeSessions.entries()) {
    let targetNum = '';
    if (sessions[id]) targetNum = sessions[id].ownerNumber;
    else if (id === config.sessionID) targetNum = config.ownerNumber[0];
    if (!targetNum) continue;
    const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
    queueNotification(id, jid, globalMsg);
    const sock = activeSessions.get(id);
    if (sock) flushNotifications(id, sock).catch(() => {});
  }
  console.log(`📋 Global settings notifications queued for ${activeSessions.size} session(s)`);
  
  res.json({ success: true });
});

app.get('/api/google-emails', isAuthenticated, async (req, res) => {
  const settings = database.getGlobalSettingsSync();
  res.json({ emails: settings.google_allowed_emails || [] });
});

app.post('/api/google-emails/add', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ success: false, message: 'Only owner can manage Google login' });
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ success: false, message: 'Invalid email' });
  const settings = database.getGlobalSettingsSync();
  const emails = settings.google_allowed_emails || [];
  if (!emails.map(e => e.toLowerCase()).includes(email.toLowerCase())) {
    emails.push(email.toLowerCase());
    await database.updateGlobalSettings({ google_allowed_emails: emails });
  }
  res.json({ success: true });
});

app.post('/api/google-emails/remove', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).json({ success: false, message: 'Only owner can manage Google login' });
  const { email } = req.body;
  const settings = database.getGlobalSettingsSync();
  const emails = (settings.google_allowed_emails || []).filter(e => e.toLowerCase() !== email.toLowerCase());
  await database.updateGlobalSettings({ google_allowed_emails: emails });
  res.json({ success: true });
});

app.get('/api/admin/global-settings', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  const settings = await database.getGlobalSettings();
  res.json(settings);
});

app.post('/api/admin/global-settings/update', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  const { whatsappChannel } = req.body;
  await database.updateGlobalSettings({ whatsappChannel });
  res.json({ success: true });
});

app.get('/api/user/channel', isAuthenticated, async (req, res) => {
  const settings = await database.getGlobalSettings();
  res.json({ channel: settings.whatsappChannel || '' });
});

app.get('/api/admin/stats', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  try {
    const sessions = await database.getAllSessions();
    const users = await database.query("SELECT COUNT(*) as count FROM dashboard_users");
    const activeCount = Array.from(activeSessions.keys()).length;
    
    // Additional metrics
    const botTypes = Object.values(sessions).reduce((acc, s) => {
      acc[s.name] = (acc[s.name] || 0) + 1;
      return acc;
    }, {});

    res.json({
      totalBots: Object.keys(sessions).length || 0,
      activeBots: activeCount || 0,
      totalUsers: (users && users[0] && users[0].count) || 0,
      memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB',
      botTypes
    });
  } catch (e) {
    console.error('Error fetching admin stats:', e);
    res.json({ totalBots: 0, activeBots: 0, totalUsers: 0, memory: '0 MB', botTypes: {} });
  }
});

app.get('/api/admin/users', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  try {
    const users = await database.query("SELECT username FROM dashboard_users");
    const result = Array.isArray(users) ? users : [];
    res.json(result);
  } catch (e) {
    console.error('Error fetching admin users:', e);
    res.json([]);
  }
});

app.post('/api/admin/broadcast', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  const { message, type, target, scope } = req.body;
  if (!message) return res.status(400).send('Message required');

  const icons = { info: '📢', warn: '⚠️', alert: '🚨' };
  const icon = icons[type] || '📢';
  const prefix = type === 'alert' ? '*[URGENT]* ' : '';

  let successCount = 0;
  const sessions = await database.getAllSessions();

  for (const [id, sock] of activeSessions.entries()) {
    try {
      const sessionData = sessions[id];
      const targetNum = sessionData?.ownerNumber || (id === config.sessionID ? config.ownerNumber[0] : null);
      
      if (targetNum) {
        if (scope === 'contacts') {
          // Broadcast to all contacts of this bot
          const contacts = await sock.store?.contacts || {};
          const jids = Object.keys(contacts).filter(jid => jid.endsWith('@s.whatsapp.net'));
          for (const jid of jids) {
            await sock.sendMessage(jid, { text: `${icon} ${prefix}*BROADCAST*\n\n${message}` }).catch(() => {});
          }
          successCount++;
        } else {
          // Default: Broadcast to bot owner only
          const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text: `${icon} ${prefix}*SYSTEM BROADCAST*\n\n${message}` });
          successCount++;
        }
      }
    } catch (e) {
      console.error(`Broadcast failed for session ${id}:`, e.message);
    }
  }
  res.json({ success: true, sentTo: successCount });
});

app.post('/api/admin/user/action', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  const { username, action } = req.body;
  
  try {
    if (action === 'delete') {
      // Find all sessions for this user and stop them
      const sessions = await database.getAllSessions();
      for (const id in sessions) {
        if (sessions[id].userId === username) {
          if (activeSessions.has(id)) {
            const sock = activeSessions.get(id);
            sock.end();
            activeSessions.delete(id);
          }
          await database.deleteSession(id);
        }
      }
      await database.run("DELETE FROM dashboard_users WHERE username = ?", [username]);
      res.json({ success: true });
    } else if (action === 'pause') {
      const sessions = await database.getAllSessions();
      for (const id in sessions) {
        if (sessions[id].userId === username && activeSessions.has(id)) {
          const sock = activeSessions.get(id);
          sock.end();
          activeSessions.delete(id);
        }
      }
      res.json({ success: true });
    }
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.post('/api/admin/bot/warn', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  const { sessionId, message } = req.body;
  
  try {
    const sessions = await database.getAllSessions();
    const session = sessions[sessionId];
    if (session && activeSessions.has(sessionId)) {
      const sock = activeSessions.get(sessionId);
      const targetNum = session.ownerNumber;
      const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: `⚠️ *ADMIN WARNING*\n\n${message}` });
      res.json({ success: true });
    } else {
      res.status(404).send('Session not found or offline');
    }
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/api/admin/sessions', isAuthenticated, async (req, res) => {
  if (!req.session.isOwner) return res.status(403).send('Forbidden');
  try {
    const sessions = await database.getAllSessions();
    const result = Object.keys(sessions).map(id => ({
      id,
      ...sessions[id],
      status: activeSessions.has(id) ? 'Online' : 'Offline'
    }));
    res.json(result);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get('/api/stats', isAuthenticated, (req, res) => {
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);
  const fs = require('fs');
  const path = require('path');
  let cmdCount = 0;
  try {
    const cmdDir = path.join(__dirname, 'commands');
    const cats = fs.readdirSync(cmdDir).filter(f => fs.statSync(path.join(cmdDir, f)).isDirectory());
    cats.forEach(cat => {
      const files = fs.readdirSync(path.join(cmdDir, cat)).filter(f => f.endsWith('.js'));
      cmdCount += files.length;
    });
  } catch(e) {}
  res.json({
    uptime: `${h}h ${m}m ${s}s`,
    ram: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
    commands: cmdCount
  });
});

app.get('/api/testping', isAuthenticated, async (req, res) => {
  const start = Date.now();
  try {
    const userId = req.session.userId;
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    const pingMs = Date.now() - start;
    const sessions = db.getUserSessions ? db.getUserSessions(userId) : [];
    const onlineCount = Array.isArray(sessions) ? sessions.filter(s => {
      const sess = activeSessions.get(s.id);
      return sess && sess.sock;
    }).length : 0;
    res.json({
      success: true,
      ping: pingMs,
      serverPing: `${pingMs}ms`,
      status: 'online',
      uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${Math.floor(uptime%60)}s`,
      ram: (mem.rss / 1024 / 1024).toFixed(2) + ' MB',
      activeSessions: onlineCount,
      timestamp: new Date().toISOString(),
      message: `✅ Pong! Server responded in ${pingMs}ms`
    });
  } catch (e) {
    res.json({ success: false, ping: Date.now() - start, message: e.message });
  }
});


app.use((err, req, res, next) => {
  console.error('Unhandled Express error:', err.message || err);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

app.get('/api/status', isAuthenticated, (req, res) => {
  try {
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const activeSessCount = activeSessions.size;
    
    res.json({
      success: true,
      status: 'online',
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
      },
      activeSessions: activeSessCount,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

} // end registerRoutes

process.on('SIGINT', () => {
  console.log('⚠️ Received SIGINT, shutting down gracefully...');
  server.close(() => process.exit(0));
});

// Main Bot logic
let sock = null;
let reconnectTimer = null;
let isConnecting = false;
let backoffMs = 5000;
const BACKOFF_MAX = 60000;

// Re-initialize all saved sessions on startup
async function initAllSessions() {
  try {
    // Wait for Firebase to finish loading before starting sessions
    await database.ready();
    const sessions = await database.getAllSessions();

    // On startup, clear the paused flag and reset retry count so sessions that were
    // paused during a previous run (e.g. while Replit was sleeping) get a fresh chance.
    // A restart is the natural recovery mechanism — we never permanently delete on startup.
    for (const id in sessions) {
      if (sessions[id]?.paused) {
        console.log(`🔄 Startup: clearing paused flag for session ${id} — giving it a fresh retry`);
        sessions[id].paused = false;
        sessions[id]._retryCount = 0;
        database.patchSession(id, { paused: false }).catch(() => {});
      }
    }

    // Connect sessions in batches of 3 so we don't saturate the event loop or
    // WhatsApp's rate limits when 50+ sessions start simultaneously.
    const SESSION_BATCH_SIZE = 3;
    const sessionIds = Object.keys(sessions);
    for (let i = 0; i < sessionIds.length; i += SESSION_BATCH_SIZE) {
      const batch = sessionIds.slice(i, i + SESSION_BATCH_SIZE);
      console.log(`♻️ Startup: connecting batch ${Math.floor(i / SESSION_BATCH_SIZE) + 1} — ${batch.map(s => s.substring(0, 20)).join(', ')}`);
      await Promise.all(batch.map(id => connectSession(id, sessions[id])));
      // Brief gap between batches to avoid WhatsApp seeing a connection burst
      if (i + SESSION_BATCH_SIZE < sessionIds.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // Connect global session from config if it exists and isn't in dashboard sessions
    if (config.sessionID && !sessions[config.sessionID]) {
       console.log('♻️ Connecting global session from config.js');
       const globalSessionData = {
         folder: config.sessionName || 'session',
         name: config.botName || 'Infinity MD (Global)',
         ownerName: config.ownerName[0],
         ownerNumber: config.ownerNumber[0]
       };
       await connectSession(config.sessionID, globalSessionData);
    }
  } catch (e) {
    console.error('Init Sessions Error:', e);
  }
}

function initSessions() {
  // Delay startup slightly so the previous deployment instance has time
  // to fully shut down before this instance grabs WhatsApp connections.
  // This prevents cascading 440 (Connection Replaced) errors on redeploy.
  const STARTUP_DELAY = parseInt(process.env.SESSION_STARTUP_DELAY_MS || '30000', 10);
  console.log(`⏳ Waiting ${STARTUP_DELAY / 1000}s before connecting sessions (letting old instance close)...`);
  setTimeout(() => {
    initAllSessions();
    startSelfPing();
    startSessionHealthMonitor();
  }, STARTUP_DELAY);
}

// ── Self-Ping: keeps the process awake on platforms that sleep idle apps ──────
function startSelfPing() {
  const PING_INTERVAL = parseInt(process.env.SELF_PING_INTERVAL_MS || String(2 * 60 * 1000), 10);
  setInterval(() => {
    try {
      // Support Replit, Railway, and generic PUBLIC_URL env vars
      const publicUrl = process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : process.env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
          : process.env.PUBLIC_URL || null;
      const selfUrl = publicUrl
        ? `${publicUrl}/health`
        : `http://localhost:${PORT}/health`;
      const mod = selfUrl.startsWith('https') ? require('https') : http;
      const req = mod.get(selfUrl, { timeout: 10000 }, (res) => {
        res.resume();
      });
      req.on('error', () => {});
      req.end();
    } catch (_) {}
  }, PING_INTERVAL);
  console.log('💓 Self-ping keepalive started');
}

// ── Session Health Monitor: reconnects sessions that silently dropped ─────────
const sessionOfflineSince = new Map(); // tracks when each session first went offline
const sessionPausedSince  = new Map(); // tracks when each session entered paused state
const AUTO_UNPAUSE_MS     = 15 * 60 * 1000; // auto-un-pause after 15 minutes

async function startSessionHealthMonitor() {
  const HEALTH_CHECK_INTERVAL = 30 * 1000; // every 30 seconds (was 90s)
  setInterval(async () => {
    try {
      const sessions = await database.getAllSessions();
      for (const id of Object.keys(sessions)) {

        // ── Zombie socket detection: in activeSessions but WebSocket is dead ──
        if (activeSessions.has(id)) {
          const liveSock = activeSessions.get(id);
          const wsState = liveSock?.ws?.readyState;
          // WebSocket.OPEN = 1; anything else (CLOSING=2, CLOSED=3, CONNECTING=0) is bad
          const isZombie = wsState !== undefined && wsState !== 1;
          if (!isZombie) {
            sessionOfflineSince.delete(id);
            sessionPausedSince.delete(id);
            continue; // healthy — skip
          }
          // Zombie: force-remove and fall through to reconnect logic
          console.warn(`🧟 Health monitor: session ${id} has dead socket (ws=${wsState}) — forcing reconnect.`);
          activeSessions.delete(id);
          try { liveSock?.end?.(); } catch (_) {}
          try { liveSock?.ev?.removeAllListeners(); } catch (_) {}
        }

        if (reconnectingSet.has(id))    continue; // already scheduled
        if (activelyConnecting.has(id)) continue; // already inside connectSession()

        // Skip sessions whose 440 cooldown hasn't expired yet
        if (replacedSessions.has(id)) continue;

        // Auto-un-pause: if a session was paused (e.g. by long-backoff ceiling) for
        // more than AUTO_UNPAUSE_MS, clear the flag and let the health monitor retry.
        if (sessions[id]?.paused) {
          if (!sessionPausedSince.has(id)) sessionPausedSince.set(id, Date.now());
          const pausedMs = Date.now() - sessionPausedSince.get(id);
          if (pausedMs < AUTO_UNPAUSE_MS) continue; // still in cooldown
          console.log(`🔄 Health monitor: auto-un-pausing session ${id} after ${Math.round(pausedMs / 60000)} min cooldown.`);
          sessions[id].paused = false;
          sessionPausedSince.delete(id);
          database.patchSession(id, { paused: false }).catch(() => {});
          // fall through to reconnect
        }

        // Track offline duration (for logging; we no longer auto-delete)
        if (!sessionOfflineSince.has(id)) sessionOfflineSince.set(id, Date.now());
        const offlineMin = Math.round((Date.now() - sessionOfflineSince.get(id)) / 60000);

        // Session exists in DB but is not in activeSessions — schedule reconnect
        console.log(`🔍 Health monitor: session ${id} offline ${offlineMin}min — scheduling reconnect...`);
        reconnectingSet.add(id);
        // Fetch latest sessionData from DB (includes current creds) for a clean reconnect
        const freshData = sessions[id];
        setTimeout(() => {
          reconnectingSet.delete(id);
          if (!activeSessions.has(id)) {
            console.log(`♻️ Health monitor reconnecting: ${id}`);
            connectSession(id, freshData).catch(e =>
              console.error(`Health monitor reconnect failed for ${id}:`, e.message)
            );
          }
        }, 5000 + Math.random() * 5000); // stagger 5–10s to avoid thundering herd
      }
    } catch (e) {
      console.error('Session health monitor error:', e.message);
    }
  }, HEALTH_CHECK_INTERVAL);
  console.log('🏥 Session health monitor started (checks every 30s, zombie detection ON)');
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function safeEndSocket() {
  try { if (sock) sock.end?.(); } catch (_) {} finally { sock = null; }
}
