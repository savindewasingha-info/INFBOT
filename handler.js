/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const { loadCommands } = require('./utils/commandLoader');
const { addMessage } = require('./utils/groupstats');
const { jidDecode, jidEncode } = require('./utils/baileys');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pino = require('pino');

const menuModule = require('./commands/general/menu');
let ytModule;
try { ytModule = require('./commands/media/yt'); } catch(e) { ytModule = null; }
let storeModule;
try { storeModule = require('./lib/lightweight_store'); } catch(e) { storeModule = null; }

// Group metadata cache to prevent rate limiting
const groupMetadataCache = new Map();
const CACHE_TTL = 300000; // 5 minute cache

// Global message dedup — prevents the same message being processed by multiple
// concurrent sessions (e.g. duplicate bots on the same number).
const processedMsgIds = new Set();
const PROCESSED_TTL   = 2 * 60 * 1000; // 2 minutes

// Unique active-user tracker — every non-bot sender seen since startup
const uniqueUsers = new Set();
global.uniqueUsers = uniqueUsers;

// Anti-ViewOnce cache: stores intercepted view-once media for reaction-based retrieval
const viewOnceCache = new Map(); // msgId -> { buffer, mediaType, media, from, sender, groupName, ts }
const VIEW_ONCE_CACHE_TTL = 3600000; // 1 hour
const VIEW_ONCE_CACHE_MAX = 300; // max entries
function pruneViewOnceCache() {
  const now = Date.now();
  for (const [k, v] of viewOnceCache) {
    if (now - v.ts > VIEW_ONCE_CACHE_TTL) viewOnceCache.delete(k);
  }
  if (viewOnceCache.size > VIEW_ONCE_CACHE_MAX) {
    const oldest = [...viewOnceCache.entries()].sort((a,b) => a[1].ts - b[1].ts);
    oldest.slice(0, viewOnceCache.size - VIEW_ONCE_CACHE_MAX).forEach(([k]) => viewOnceCache.delete(k));
  }
}

// Status cache — shared with save.js via utils/statusStore.js
const statusStore = require('./utils/statusStore');

// Load all commands
const { commands: cmdRegistry } = require('./command');
const commands = loadCommands();

// Merge registries
cmdRegistry.forEach((cmdObj, name) => {
  commands.set(name, cmdObj);
});

// Unwrap WhatsApp containers (ephemeral, view once, etc.)
const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;
  
  let m = msg.message;
  
  // Common wrappers in modern WhatsApp
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  
  // You can add more wrappers if needed later
  return m;
};

// Cached group metadata getter with rate limit handling (for non-admin checks)
const getCachedGroupMetadata = async (sock, groupId) => {
  try {
    // Validate group JID before attempting to fetch
    if (!groupId || !groupId.endsWith('@g.us')) {
      return null;
    }
    
    // Check cache first
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data; // Return cached data (even if null for forbidden groups)
    }
    
    // Fetch from API
    const metadata = await sock.groupMetadata(groupId);
    
    // Cache it
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // Handle forbidden (403) errors - cache null to prevent retry storms
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Cache null for forbidden groups to prevent repeated attempts
      groupMetadataCache.set(groupId, {
        data: null,
        timestamp: Date.now()
      });
      return null; // Silently return null for forbidden groups
    }
    
    // Handle rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      const cached = groupMetadataCache.get(groupId);
      if (cached) {
        return cached.data;
      }
      return null;
    }
    
    // For other errors, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    
    // Return null instead of throwing to prevent crashes
    return null;
  }
};

// Live group metadata getter (always fresh, no cache) - for admin checks
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    // Always fetch fresh metadata, bypass cache
    const metadata = await sock.groupMetadata(groupId);
    
    // Update cache for other features (antilink, welcome, etc.)
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // On error, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    return null;
  }
};

// Alias for backward compatibility (non-admin features use cached)
const getGroupMetadata = getCachedGroupMetadata;

let _sessionsCache = null;
let _sessionsCacheTime = 0;
const SESSIONS_CACHE_TTL = 30000;

const isOwner = (sender, currentSock = null) => {
  if (!sender) return false;
  
  const normalizedSender = normalizeJidWithLid(sender);
  const senderNumber = normalizeJid(normalizedSender);
  
  if (currentSock && currentSock._customConfig) {
     const ownerNum = currentSock._customConfig.ownerNumber;
     if (ownerNum) {
        const owners = Array.isArray(ownerNum) ? ownerNum : [ownerNum];
        return owners.some(o => normalizeJid(o) === senderNumber);
     }
  }

  const globalOwners = config.ownerNumber.some(owner => {
    const normalizedOwner = normalizeJidWithLid(owner.includes('@') ? owner : `${owner}@s.whatsapp.net`);
    const ownerNumber = normalizeJid(normalizedOwner);
    return ownerNumber === senderNumber;
  });

  if (globalOwners) return true;

  try {
    const now = Date.now();
    if (!_sessionsCache || now - _sessionsCacheTime > SESSIONS_CACHE_TTL) {
      _sessionsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'database', 'sessions.json'), 'utf-8'));
      _sessionsCacheTime = now;
    }
    return Object.values(_sessionsCache).some(s => normalizeJid(s.ownerNumber) === senderNumber);
  } catch (e) {
    return false;
  }
};

const isMod = (sender) => {
  const number = sender.split('@')[0];
  return database.isModerator(number);
};

// LID mapping cache
const lidMappingCache = new Map();

// Helper to normalize JID to just the number part
const normalizeJid = (jid) => {
  if (!jid) return null;
  if (typeof jid !== 'string') return null;
  
  // Remove device ID if present (e.g., "1234567890:0@s.whatsapp.net" -> "1234567890")
  if (jid.includes(':')) {
    return jid.split(':')[0];
  }
  // Remove domain if present (e.g., "1234567890@s.whatsapp.net" -> "1234567890")
  if (jid.includes('@')) {
    return jid.split('@')[0];
  }
  return jid;
};

// Get LID mapping value from session files
const getLidMappingValue = (user, direction) => {
  if (!user) return null;
  
  const cacheKey = `${direction}:${user}`;
  if (lidMappingCache.has(cacheKey)) {
    return lidMappingCache.get(cacheKey);
  }
  
  const sessionPath = path.join(__dirname, config.sessionName || 'session');
  const suffix = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filePath = path.join(sessionPath, `lid-mapping-${user}${suffix}`);
  
  if (!fs.existsSync(filePath)) {
    lidMappingCache.set(cacheKey, null);
    return null;
  }
  
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const value = raw ? JSON.parse(raw) : null;
    lidMappingCache.set(cacheKey, value || null);
    return value || null;
  } catch (error) {
    lidMappingCache.set(cacheKey, null);
    return null;
  }
};

// Normalize JID handling LID conversion
const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    }
    
    let user = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) {
        user = pnUser;
        server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        return true;
      }
      return false;
    };
    
    if (server === 'lid' || server === 'hosted.lid') {
      mapToPn();
    } else if (server === 's.whatsapp.net' || server === 'hosted') {
      mapToPn();
    }
    
    if (server === 'hosted') {
      return jidEncode(user, 'hosted');
    }
    return jidEncode(user, 's.whatsapp.net');
  } catch (error) {
    return jid;
  }
};

// Build comparable JID variants (PN + LID) for matching
const buildComparableIds = (jid) => {
  if (!jid) return [];
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return [normalizeJidWithLid(jid)].filter(Boolean);
    }
    
    const variants = new Set();
    const normalizedServer = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    variants.add(jidEncode(decoded.user, normalizedServer));
    
    const isPnServer = normalizedServer === 's.whatsapp.net' || normalizedServer === 'hosted';
    const isLidServer = normalizedServer === 'lid' || normalizedServer === 'hosted.lid';
    
    if (isPnServer) {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) {
        const lidServer = normalizedServer === 'hosted' ? 'hosted.lid' : 'lid';
        variants.add(jidEncode(lidUser, lidServer));
      }
    } else if (isLidServer) {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) {
        const pnServer = normalizedServer === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        variants.add(jidEncode(pnUser, pnServer));
      }
    }
    
    return Array.from(variants);
  } catch (error) {
    return [jid];
  }
};

// Find participant by either PN JID or LID JID
const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));
  
  if (!targets.length) return null;
  
  return participants.find(participant => {
    if (!participant) return false;
    
    const participantIds = [
      participant.id,
      participant.lid,
      participant.userJid
    ]
      .filter(Boolean)
      .flatMap(id => buildComparableIds(id));
    
    return participantIds.some(id => targets.includes(id));
  }) || null;
};

const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant) return false;
  if (!groupId || !groupId.endsWith('@g.us')) return false;
  
  let metadata = groupMetadata;
  if (!metadata || !metadata.participants) {
    metadata = await getCachedGroupMetadata(sock, groupId);
  }
  if (!metadata || !metadata.participants) return false;
  
  const foundParticipant = findParticipant(metadata.participants, participant);
  if (!foundParticipant) return false;
  
  return foundParticipant.admin === 'admin' || foundParticipant.admin === 'superadmin';
};

const isBotAdmin = async (sock, groupId, groupMetadata = null) => {
  if (!sock.user || !groupId) return false;
  if (!groupId.endsWith('@g.us')) return false;
  
  try {
    const botId = sock.user.id;
    const botLid = sock.user.lid;
    if (!botId) return false;
    
    const botJids = [botId];
    if (botLid) botJids.push(botLid);
    
    let metadata = groupMetadata;
    if (!metadata || !metadata.participants) {
      metadata = await getCachedGroupMetadata(sock, groupId);
    }
    if (!metadata || !metadata.participants) return false;
    
    const participant = findParticipant(metadata.participants, botJids);
    if (!participant) return false;
    
    return participant.admin === 'admin' || participant.admin === 'superadmin';
  } catch (error) {
    return false;
  }
};

const isUrl = (text) => {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  return urlRegex.test(text);
};

const hasGroupLink = (text) => {
  const linkRegex = /chat.whatsapp.com\/([0-9A-Za-z]{20,24})/i;
  return linkRegex.test(text);
};

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || 
         jid.includes('status.broadcast') || 
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Main message handler
const handleMessage = async (sock, msg) => {
  try {
    if (!msg || !msg.message || !sock || !sock.user) return;

    const from = msg.key.remoteJid;
    const msgId = msg.key.id;

    // ── Anti-ViewOnce: runs PER-SESSION before dedup so every bot independently
    //    intercepts view-once media sent to it (dedup would block 2nd+ sessions).
    if (!msg.key.fromMe && from && !from.includes('@broadcast') && from !== 'status.broadcast' && !from.includes('@newsletter')) {
      try {
        const _gs = database.getGlobalSettingsSync();
        const _ss = sock._customConfig?.settings || {};
        const _eff = { ..._gs, ..._ss };
        if (_eff.antiviewonce) {
          // ── Reaction-based retrieval (react to any cached view-once) ──
          if (msg.message?.reactionMessage) {
            const _reaction = msg.message.reactionMessage;
            const _reactedId = _reaction.key?.id;
            if (_reactedId && viewOnceCache.has(_reactedId)) {
              const _cached = viewOnceCache.get(_reactedId);
              const _ownerNum = (sock._customConfig?.ownerNumber || config.ownerNumber[0] || '').replace(/[^0-9]/g, '');
              const _ownerJid = _ownerNum + '@s.whatsapp.net';
              const _senderNum = _cached.sender.split('@')[0];
              const _isGroup = from.endsWith('@g.us');
              const _caption =
                `👁️ *Anti-ViewOnce (Reaction Triggered)*\n\n` +
                `${_cached.groupName ? `*Group:* ${_cached.groupName}\n` : `*Private Chat*\n`}` +
                `*Sender:* @${_senderNum}\n` +
                `*React Emoji:* ${_reaction.text || '?'}\n` +
                (_cached.caption ? `*Caption:* ${_cached.caption}\n` : '') +
                `*Type:* ${_cached.mediaType.replace('Message', '')}\n\n` +
                `_Saved because someone reacted to this view-once._`;
              const _sendType = _cached.mediaType.replace('Message', '');
              const _sendObj = { [_sendType]: _cached.buffer, caption: _caption, mentions: [_cached.sender] };
              if (_cached.mimetype) _sendObj.mimetype = _cached.mimetype;
              await sock.sendMessage(_ownerJid, _sendObj).catch(() => {});
            }
          }

          // ── Intercept new view-once messages ──
          let _rawMsg = msg.message;
          if (_rawMsg.ephemeralMessage) _rawMsg = _rawMsg.ephemeralMessage.message;
          if (_rawMsg.viewOnceMessageV2Extension) _rawMsg = { viewOnceMessageV2: _rawMsg.viewOnceMessageV2Extension };
          const _voType = _rawMsg.viewOnceMessageV2 ? 'viewOnceMessageV2' : _rawMsg.viewOnceMessage ? 'viewOnceMessage' : null;
          if (_voType) {
            const _viewOnce = _rawMsg[_voType]?.message;
            if (_viewOnce) {
              const _mediaType = Object.keys(_viewOnce).find(k => k !== 'messageContextInfo');
              if (_mediaType) {
                const _media = _viewOnce[_mediaType];
                const { downloadMediaMessage } = require('./utils/baileys');
                let _buffer;
                try {
                  _buffer = await downloadMediaMessage(
                    { key: msg.key, message: _rawMsg[_voType].message },
                    'buffer', {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                  );
                } catch (_dlErr) {
                  try {
                    _buffer = await downloadMediaMessage(
                      { key: msg.key, message: { [_voType]: _rawMsg[_voType] } },
                      'buffer', {},
                      { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                    );
                  } catch (_dlErr2) {
                    console.error('Anti-ViewOnce: both download attempts failed:', _dlErr2.message);
                  }
                }
                if (_buffer) {
                  pruneViewOnceCache();
                  const _isGroupVO = from.endsWith('@g.us');
                  let _groupName = null;
                  if (_isGroupVO) {
                    try { _groupName = (await getGroupMetadata(sock, from))?.subject || from; } catch {}
                  }
                  const _senderVO = msg.key.participant || msg.key.remoteJid;
                  viewOnceCache.set(msg.key.id, {
                    buffer: _buffer, mediaType: _mediaType, mimetype: _media.mimetype,
                    caption: _media.caption || '', from, sender: _senderVO,
                    groupName: _isGroupVO ? _groupName : null, ts: Date.now()
                  });
                  const _ownerNum = (sock._customConfig?.ownerNumber || config.ownerNumber[0] || '').replace(/[^0-9]/g, '');
                  const _ownerJid = _ownerNum + '@s.whatsapp.net';
                  const _senderNum = _senderVO.split('@')[0];
                  const _chatInfo = _isGroupVO ? `*Group:* ${_groupName || from}` : `*Private Chat*`;
                  const _contextCaption =
                    `🛡️ *Anti-ViewOnce Alert*\n\n` +
                    `${_chatInfo}\n` +
                    `*Sender:* @${_senderNum}\n` +
                    (_media.caption ? `*Caption:* ${_media.caption}\n` : '') +
                    `*Type:* ${_mediaType.replace('Message', '')}\n\n` +
                    `_View-once intercepted. React to the original with any emoji to retrieve it again._`;
                  const _sendType = _mediaType.replace('Message', '');
                  const _sendObj = { [_sendType]: _buffer, caption: _contextCaption, mentions: [_senderVO] };
                  if (_media.mimetype) _sendObj.mimetype = _media.mimetype;
                  await sock.sendMessage(_ownerJid, _sendObj).catch(() => {});
                  const _reactEmoji = _eff.antiviewonceEmoji || '👁️';
                  await sock.sendMessage(from, { react: { text: _reactEmoji, key: msg.key } }).catch(() => {});
                }
              }
            }
          }
        }
      } catch (_voErr) {
        console.error('Anti-ViewOnce (pre-dedup) error:', _voErr.message);
      }
    }

    // ── Global dedup: skip if another session already handled this message ──
    if (msgId && !msg.key.fromMe) {
      if (processedMsgIds.has(msgId)) return;
      processedMsgIds.add(msgId);
      setTimeout(() => processedMsgIds.delete(msgId), PROCESSED_TTL);
    }
    
    // ── Status Broadcast Handling ─────────────────────────────────────────────
    if (from === 'status.broadcast') {
      const settings = database.getGlobalSettingsSync();

      const statusSaveMode = settings.statusSave; // false | 'on' | true | 'heart'
      // Also activate caching when autoStatus is on (so .save command works automatically)
      const statusSaveActive = (statusSaveMode && statusSaveMode !== false) || settings.autoStatus;
      const HEART_EMOJIS = ['❤', '❤️', '🩷', '🧡', '♥'];

      function reactQualifies(emoji) {
        if (!statusSaveActive) return false;
        if (statusSaveMode === 'heart') return HEART_EMOJIS.includes((emoji || '').trim());
        return true; // 'on' / true → any emoji
      }

      // ── Owner reacted to a status → auto-save ──────────────────────────────
      if (msg.key.fromMe && msg.message?.reactionMessage) {
        if (statusSaveActive) {
          try {
            const reaction = msg.message.reactionMessage;
            const emoji = reaction.text || '';
            const reactedId = reaction.key?.id;

            if (reactedId && reactQualifies(emoji)) {
              const cached = statusStore.getCache(reactedId);

              if (!cached) {
                // Not in cache — was seen before statusSave was enabled
                console.log(`[StatusSave] React on ${reactedId} but not in cache (enable before viewing)`);
              } else if (statusStore.isAlreadySaved(reactedId)) {
                // Already saved — ignore duplicate react
                console.log(`[StatusSave] ${reactedId} already saved, skipping duplicate`);
              } else {
                const ownerNum = (sock._customConfig?.ownerNumber || config.ownerNumber[0] || '').replace(/[^0-9]/g, '');
                const ownerJid = ownerNum + '@s.whatsapp.net';
                const senderNum = cached.sender?.replace(/@s\.whatsapp\.net$/, '') || 'unknown';
                const timeStr = new Date(cached.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

                const caption =
                  `📸 *Status Saved*\n\n` +
                  `👤 *From:* @${senderNum}\n` +
                  `🕐 *Posted:* ${timeStr}\n` +
                  (cached.caption ? `💬 *Caption:* ${cached.caption}\n` : '') +
                  `${emoji ? `😊 *React:* ${emoji}\n` : ''}` +
                  `\n> 💫 *Infinity MD — React to Save*`;

                const sendType = cached.mediaType.replace('Message', '');
                await sock.sendMessage(ownerJid, {
                  [sendType]: cached.buffer,
                  mimetype: cached.mimetype,
                  caption,
                  mentions: [cached.sender]
                });

                statusStore.markSaved(reactedId);
                console.log(`💾 Status saved (${emoji}) from @${senderNum}`);
              }
            }
          } catch (e) {
            console.error('[StatusSave] Reaction save error:', e.message);
          }
        }
        return;
      }

      // ── Incoming status from others ─────────────────────────────────────────
      if (!msg.key.fromMe) {
        const sender = msg.key.participant || msg.key.remoteJid;

        // Auto-view
        if (settings.autoStatus) {
          await sock.readMessages([msg.key]).catch(() => {});
          console.log(`👀 Viewed status from: ${sender}`);
        }

        // Cache media for react-to-save
        if (statusSaveActive) {
          const msgId = msg.key.id;

          // Skip if already cached or download in progress
          if (statusStore.getCache(msgId) || statusStore.pendingDownloads.has(msgId)) {
            return;
          }

          const content = msg.message;
          const mediaType = ['imageMessage', 'videoMessage', 'audioMessage'].find(t => content?.[t]);

          if (mediaType) {
            statusStore.pendingDownloads.add(msgId);
            try {
              const { downloadMediaMessage } = require('./utils/baileys');
              const media = content[mediaType];

              // Primary download attempt
              let buffer = null;
              try {
                buffer = await downloadMediaMessage(
                  msg, 'buffer', {},
                  { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                );
              } catch (dlErr) {
                console.warn(`[StatusSave] Primary download failed, retrying: ${dlErr.message}`);
                // Fallback: wrap message for reupload
                try {
                  const reuploaded = await sock.updateMediaMessage(msg);
                  buffer = await downloadMediaMessage(
                    reuploaded, 'buffer', {},
                    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
                  );
                } catch (fallbackErr) {
                  console.error(`[StatusSave] Fallback download also failed: ${fallbackErr.message}`);
                }
              }

              if (buffer) {
                statusStore.setCache(msgId, {
                  buffer,
                  mediaType,
                  mimetype: media.mimetype || '',
                  caption: media.caption || '',
                  sender
                });
                console.log(`📦 Cached status [${mediaType.replace('Message', '')}] from @${sender.replace(/@s\.whatsapp\.net$/, '')}`);
              }
            } finally {
              statusStore.pendingDownloads.delete(msgId);
            }
          }
        }
      }
      return;
    }

    if (isSystemJid(from)) return;
    
    const globalSettings = database.getGlobalSettingsSync();
    const sessionSettings = sock._customConfig?.settings || {};
    const effectiveSettings = {
      ...globalSettings,
      ...sessionSettings
    };

    const sender = msg.key.fromMe ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : msg.key.participant || msg.key.remoteJid;

    // Maintenance Mode Check
    if (globalSettings.maintenance && !isOwner(sender, sock)) {
      return;
    }

    // Auto-Typing & Auto-Voice: fired per-command inside the command block below.
    // Do NOT fire here — this point is reached for every message (reactions,
    // media, non-commands) which causes the indicator to stick permanently.

    // Auto-React System
    try {
      const autoReactEnabled = effectiveSettings.autoReact || config.autoReact;
      const autoReactMode = effectiveSettings.autoReactMode || config.autoReactMode || 'all';

      if (autoReactEnabled && msg.message && !msg.key.fromMe) {
        const rawForReact = msg.message.ephemeralMessage?.message || msg.message;
        // Skip reaction messages and protocol messages — reacting to them causes errors/loops
        if (!rawForReact.reactionMessage && !rawForReact.protocolMessage) {
          const text = rawForReact.conversation || rawForReact.extendedTextMessage?.text || '';
          const jid = msg.key.remoteJid;
          const isGroupMsg = jid.endsWith('@g.us');

          // Default large random emoji pool — overridden per-session via autoReactEmojis setting
          const DEFAULT_EMOJIS = [
            '❤️','🔥','👌','💀','😁','✨','👍','🤨','😎','😂','🤝','💫',
            '🌙','⚡','🎯','💯','🤩','😍','🥳','🎉','💪','🙌','👏','🤣',
            '😜','🥴','🫡','💥','🌟','🏆','🫶','😏','🤙','🙏','😤','🤯',
            '😈','🥶','🫠','💎','🚀','🦋','🌈','🍀','🎵','👀','🤫','😇'
          ];
          const emojiPool = (effectiveSettings.autoReactEmojis && effectiveSettings.autoReactEmojis.length > 0)
            ? effectiveSettings.autoReactEmojis
            : DEFAULT_EMOJIS;

          const prefixList = ['.', '/', '#', '!'];
          const isCmd = text && prefixList.includes(text.trim()[0]);

          // Determine if this message qualifies under the current mode
          let shouldReact = false;
          if (isCmd) {
            // Commands always get ⏳ regardless of mode
            sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } }).catch(() => {});
          } else {
            switch (autoReactMode) {
              case 'cmd-only':
                shouldReact = false;
                break;
              case 'groups-only':
                shouldReact = isGroupMsg;
                break;
              case 'private-only':
                shouldReact = !isGroupMsg;
                break;
              case 'all':
              default:
                shouldReact = true;
                break;
            }
            if (shouldReact) {
              const rand = emojiPool[Math.floor(Math.random() * emojiPool.length)];
              sock.sendMessage(jid, { react: { text: rand, key: msg.key } }).catch(() => {});
            }
          }
        }
      }
    } catch (e) {}
    
    const content = getMessageContent(msg);
    let actualMessageTypes = [];
    if (content) {
      const allKeys = Object.keys(content);
      const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = allKeys.filter(key => !protocolMessages.includes(key));
    }
    const messageType = actualMessageTypes[0];
    const isGroup = from.endsWith('@g.us');
    const groupMetadata = isGroup ? await getGroupMetadata(sock, from) : null;
    
    // Track group message statistics
    if (isGroup) {
      addMessage(from, sender);
    }

    // Track unique active users (all non-bot senders, group + private)
    if (!msg.key.fromMe && sender) {
      const senderNum = sender.split('@')[0].split(':')[0];
      if (senderNum) uniqueUsers.add(senderNum);
    }
    
    // Anti-Delete System
    const isPrivate = !isGroup;
    const adEnabled = effectiveSettings.antidelete;
    const adPrivate = true; // Always allow in private if enabled
    const adGroup = true;   // Always allow in groups if enabled

    if (adEnabled && msg.message?.protocolMessage?.type === 0) {
       const key = msg.message.protocolMessage.key;
       const deletedMsg = await database.getDeletedMessage(key.id);
       if (deletedMsg) {
           const targetNum = sock._customConfig?.ownerNumber || config.ownerNumber[0];
           const jid = targetNum.includes('@') ? targetNum : `${targetNum}@s.whatsapp.net`;
           const note = `🛡️ *Anti-Delete Detected*\n\n*From:* @${deletedMsg.sender.split('@')[0]}\n*Chat:* ${isGroup ? 'Group' : 'Private'}\n*Type:* ${deletedMsg.type}\n\n*Content:* ${deletedMsg.body || 'Media/Unsupported'}`;
           await sock.sendMessage(from, { text: note, mentions: [deletedMsg.sender] }).catch(() => {});
       }
    }
    
    if (adEnabled && !msg.key.fromMe && !isSystemJid(from)) {
       let msgBody = '';
       if (content) {
         if (content.conversation) msgBody = content.conversation;
         else if (content.extendedTextMessage) msgBody = content.extendedTextMessage.text || '';
         else if (content.imageMessage) msgBody = content.imageMessage.caption || '';
         else if (content.videoMessage) msgBody = content.videoMessage.caption || '';
       }
       database.saveDeletedMessage(msg.key.id, {
         sender,
         type: messageType,
         body: msgBody,
         timestamp: Date.now()
       });
    }
    
    // Anti-ViewOnce is now handled per-session BEFORE global dedup (see top of handleMessage)

    if (!content || actualMessageTypes.length === 0) return;
    
    let body = '';
    if (content.conversation) body = content.conversation;
    else if (content.extendedTextMessage) body = content.extendedTextMessage.text || '';
    else if (content.imageMessage) body = content.imageMessage.caption || '';
    else if (content.videoMessage) body = content.videoMessage.caption || '';
    // Handle WhatsApp interactive/button responses (gifted-btns)
    else if (content.buttonsResponseMessage) {
      const btnResp = content.buttonsResponseMessage;
      body = btnResp.selectedButtonId || btnResp.selectedDisplayText || '';
    } else if (content.interactiveResponseMessage) {
      try {
        const irm = content.interactiveResponseMessage;
        // Try nativeFlowResponseMessage (gifted-btns native_flow format)
        if (irm.nativeFlowResponseMessage?.paramsJson) {
          try {
            const parsed = JSON.parse(irm.nativeFlowResponseMessage.paramsJson);
            body = parsed.id || parsed.buttonId || parsed.selectedId || parsed.display_text || '';
          } catch (_) {}
        }
        // Try nativeFlowResponseMessage name field directly
        if (!body && irm.nativeFlowResponseMessage?.name) {
          body = String(irm.nativeFlowResponseMessage.name);
        }
        // Try response field (some Baileys versions)
        if (!body && irm.response) body = String(irm.response);
        // Try body field
        if (!body && irm.body) body = String(irm.body);
        // Try selectedButtonId on irm itself
        if (!body && irm.selectedButtonId) body = String(irm.selectedButtonId);
      } catch {}
    } else if (content.templateButtonReplyMessage) {
      body = content.templateButtonReplyMessage.selectedId || content.templateButtonReplyMessage.selectedDisplayText || '';
    } else if (content.listResponseMessage) {
      body = content.listResponseMessage.singleSelectReply?.selectedRowId || '';
    }

    // Log button responses for debugging
    if (content.interactiveResponseMessage || content.buttonsResponseMessage) {
      console.log('[BTN DEBUG] raw body extracted:', JSON.stringify(body));
      if (content.interactiveResponseMessage) {
        const irm = content.interactiveResponseMessage;
        console.log('[BTN DEBUG] irm keys:', Object.keys(irm));
        if (irm.nativeFlowResponseMessage) {
          console.log('[BTN DEBUG] nativeFlow:', JSON.stringify(irm.nativeFlowResponseMessage));
        }
      }
    }

    // Map known button IDs to commands — use the per-session prefix when available
    const p = sock?._customConfig?.settings?.prefix || config.prefix || '.';
    const btnCmdMap = {
      // General nav (by ID)
      'cmd_menu': `${p}menu`,
      'cmd_alive': `${p}alive`,
      'cmd_help': `${p}help`,
      'cmd_ping': `${p}ping`,
      // Submenu category buttons
      'mediamenu':     `${p}mediamenu`,
      'dlmenu':        `${p}mediamenu`,
      'adminmenu':     `${p}adminmenu`,
      'ownermenu':     `${p}ownermenu`,
      'aimenu':        `${p}aimenu`,
      'toolmenu':      `${p}toolmenu`,
      'toolsmenu':     `${p}toolmenu`,
      'convertermenu': `${p}convertermenu`,
      'funmenu':       `${p}funmenu`,
      'generalmenu':   `${p}generalmenu`,
      // Display-text fallbacks (if WhatsApp returns button label text instead of ID)
      '📥 media':      `${p}mediamenu`,
      '🛡️ admin':      `${p}adminmenu`,
      '👑 owner':      `${p}ownermenu`,
      '🤖 ai':         `${p}aimenu`,
      '🛠️ tools':      `${p}toolmenu`,
      '🔄 converter':  `${p}convertermenu`,
      '🎉 fun':        `${p}funmenu`,
      '🧭 general':    `${p}generalmenu`,
      '🔙 main menu':  `${p}menu`,
      '🌐 website':    `${p}alive`,
      // Settings toggles
      'settings_antidelete_on': `${p}settings antidelete on`,
      'settings_antidelete_off': `${p}settings antidelete off`,
      'settings_antiviewonce_on': `${p}settings antiviewonce on`,
      'settings_antiviewonce_off': `${p}settings antiviewonce off`,
      'settings_autoreact_on': `${p}settings autoreact on`,
      'settings_autoreact_off': `${p}settings autoreact off`,
      'settings_autostatus_on': `${p}settings autostatus on`,
      'settings_autostatus_off': `${p}settings autostatus off`,
      'settings_autotyping_on': `${p}settings autotyping on`,
      'settings_autotyping_off': `${p}settings autotyping off`,
      'settings_autovoice_on': `${p}settings autovoice on`,
      'settings_autovoice_off': `${p}settings autovoice off`,
      'settings_maintenance_on': `${p}settings maintenance on`,
      'settings_maintenance_off': `${p}settings maintenance off`,
      'settings_anticall_on': `${p}settings anticall on`,
      'settings_anticall_off': `${p}settings anticall off`,
      'settings_privatemode_on': `${p}settings privatemode on`,
      'settings_privatemode_off': `${p}settings privatemode off`,
      // AntiDelete
      'antidelete_on': `${p}antidelete on`,
      'antidelete_off': `${p}antidelete off`,
      'antidelete_private': `${p}antidelete private`,
      'antidelete_group': `${p}antidelete group`,
      // Bot Mode
      'mode_private': `${p}mode private`,
      'mode_public':  `${p}mode public`,
      'mode_group':   `${p}mode group`,
      // AntiCall
      'anticall_on': `${p}anticall on`,
      'anticall_off': `${p}anticall off`,
      // Language switcher buttons
      'lang en':      `${p}lang en`,
      'lang si':      `${p}lang si`,
      // TikTok search selections
      'tiktok_pick_0': `${p}tiktok pick 0`,
      'tiktok_pick_1': `${p}tiktok pick 1`,
      'tiktok_pick_2': `${p}tiktok pick 2`,
      'tiktok_pick_3': `${p}tiktok pick 3`,
      'tiktok_pick_4': `${p}tiktok pick 4`,
      // YouTube search selections
      'yt_pick_0': `${p}yt pick 0`,
      'yt_pick_1': `${p}yt pick 1`,
      'yt_pick_2': `${p}yt pick 2`,
      'yt_pick_3': `${p}yt pick 3`,
      'yt_pick_4': `${p}yt pick 4`,
      // AntiLink
      'antilink_on': `${p}antilink on`,
      'antilink_off': `${p}antilink off`,
      'antilink_delete': `${p}antilink set delete`,
      'antilink_kick': `${p}antilink set kick`,
      // AntiTag
      'antitag_on': `${p}antitag on`,
      'antitag_off': `${p}antitag off`,
      'antitag_delete': `${p}antitag set delete`,
      'antitag_kick': `${p}antitag set kick`,
      // AutoFeatures
      'autovoice_on': `${p}autovoice on`,
      'autovoice_off': `${p}autovoice off`,
      'autoreact_on': `${p}autoreact on`,
      'autoreact_off': `${p}autoreact off`,
      'autostatus_on': `${p}autostatus on`,
      'autostatus_off': `${p}autostatus off`,
      // Group features
      'welcome_on': `${p}welcome on`,
      'welcome_off': `${p}welcome off`,
      'goodbye_on': `${p}goodbye on`,
      'goodbye_off': `${p}goodbye off`,
    };
    // Button ID map lookup — try exact match first, then lowercase
    if (body) {
      const mapped = btnCmdMap[body] || btnCmdMap[body.toLowerCase()] || btnCmdMap[body.trim().toLowerCase()];
      if (mapped) body = mapped;
    }

    // Fallback: if body doesn't start with a prefix but is a known command name, add prefix
    if (body && !body.startsWith(config.prefix) && !['/','#','!'].some(c=>body.startsWith(c))) {
      const lowerBody = body.toLowerCase();
      if (commands.has(lowerBody) || cmdRegistry.has(lowerBody)) {
        body = config.prefix + lowerBody;
        console.log('[BTN DEBUG] alias fallback matched:', lowerBody, '→', body);
      }
    }

    body = (body || '').trim();

    // Numeric Replies (Consolidated)
    try {
      const resolvedMenuCmd = (menuModule && menuModule._menuReply) ? menuModule._menuReply.resolveNumberReply(from, sender, body) : null;
      
      if (resolvedMenuCmd) {
        body = resolvedMenuCmd;
      }

      if (ytModule && ytModule._ytReply) {
        const resolvedYt = ytModule._ytReply.resolveNumberReply(from, sender, body);
        if (resolvedYt) body = resolvedYt;
      }
    } catch (e) {}

    // Command Parser
    const prefixList = [config.prefix, '/', '#', '!', '.'];
    const text = body.toLowerCase();
    const usedPrefix = prefixList.find(p => text.startsWith(p));
    
    if (usedPrefix) {
      const args = body.slice(usedPrefix.length).trim().split(/ +/);
      const commandName = args.shift().toLowerCase();
      const command = commands.get(commandName) || cmdRegistry.get(commandName);

      // Auto-delete .src if from non-owner
      if (commandName === 'src' && !isOwner(sender, sock)) {
        await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
        return;
      }

      if (command) {
        // ── Bot Mode enforcement ──────────────────────────────────────────────
        // Resolve mode: new botMode field takes priority; fall back to legacy forceBot.
        const botMode = globalSettings.botMode || (globalSettings.forceBot ? 'private' : 'public');
        if (!isOwner(sender, sock)) {
          if (botMode === 'private') {
            // Private mode: only owner can use commands, no response to outsiders
            return;
          }
          if (botMode === 'group' && !isGroup) {
            // Group mode: DM commands from non-owners are silently ignored
            return;
          }
        }

        // ── Owner-only command enforcement ────────────────────────────────────
        // Block any command flagged ownerOnly OR in the 'owner' category from
        // being executed by non-owners.  This is a hard gate — the individual
        // command handler does NOT need its own check.
        const cmdIsOwnerOnly = command.ownerOnly === true || command.category === 'owner';
        if (cmdIsOwnerOnly && !isOwner(sender, sock)) {
          await sock.sendMessage(from, {
            text: `╭━━〔 👑 *OWNER ONLY* 〕━━⬣\n┃\n┃  ❌ This command is restricted.\n┃  Only the bot owner can use it.\n┃\n╰━━━━━━━━━━━━━━━━━━━━━⬣`
          }, { quoted: msg }).catch(() => {});
          await sock.sendMessage(from, { react: { text: '🔒', key: msg.key } }).catch(() => {});
          return;
        }

        // ── Auto-Typing / Auto-Voice ──────────────────────────────────────────
        // Start indicator now (only during actual command processing), and use
        // a refresh interval so it stays visible for slow commands (e.g. .yt).
        let presenceInterval = null;
        const presenceMode = effectiveSettings.autoTyping ? 'composing'
                           : effectiveSettings.autoVoice  ? 'recording'
                           : null;
        if (presenceMode) {
          sock.sendPresenceUpdate(presenceMode, from).catch(() => {});
          // Refresh every 10 s so long-running commands keep the indicator alive
          presenceInterval = setInterval(() => {
            sock.sendPresenceUpdate(presenceMode, from).catch(() => {});
          }, 10000);
        }

        const stopPresence = () => {
          if (presenceInterval) { clearInterval(presenceInterval); presenceInterval = null; }
          if (presenceMode) sock.sendPresenceUpdate('paused', from).catch(() => {});
        };

        try {
          sock.sendMessage(from, { react: { text: '⏳', key: msg.key } }).catch(() => {});
          const executeFn = command.handler || command.execute;
          if (executeFn) {
            const [adminResult, botAdminResult] = await Promise.all([
              isAdmin(sock, sender, from, groupMetadata),
              isBotAdmin(sock, from, groupMetadata)
            ]);

            // ── Admin-only command enforcement ──────────────────────────────────
            // Block commands flagged adminOnly or category 'admin' from non-admins.
            // Bot owner bypasses this check.
            const cmdIsAdminOnly = command.adminOnly === true || command.category === 'admin';
            if (cmdIsAdminOnly && !isOwner(sender, sock) && !adminResult) {
              await sock.sendMessage(from, {
                text: `╭━━〔 👮 *ADMIN ONLY* 〕━━⬣\n┃\n┃  ❌ This command is for admins only.\n┃  You need group admin privileges\n┃  to use this command.\n┃\n╰━━━━━━━━━━━━━━━━━━━━━⬣`
              }, { quoted: msg }).catch(() => {});
              await sock.sendMessage(from, { react: { text: '🔒', key: msg.key } }).catch(() => {});
              stopPresence();
              return;
            }

            const sessionPrefix = sock?._customConfig?.settings?.prefix || config.prefix || '.';
            await executeFn(sock, msg, args, {
              from, sender, isGroup, groupMetadata,
              isOwner: isOwner(sender, sock),
              isAdmin: adminResult,
              isBotAdmin: botAdminResult,
              isMod: isMod(sender),
              commandName,
              prefix: sessionPrefix,
              q: args.join(' '),
              body,
              message: msg,
              reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }).catch(() => {}),
              react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {})
            });
          }
          stopPresence();
        } catch (error) {
          stopPresence();
          console.error(`Error executing command ${commandName}:`, error);
          await sock.sendMessage(from, { react: { text: '❌', key: msg.key } }).catch(() => {});
        }
        return;
      }
    }

    // ── Filter Commands (multi-step flows e.g. .movie selection) ──
    try {
      for (const [, cmdObj] of cmdRegistry) {
        if (typeof cmdObj.filter === 'function') {
          const matched = cmdObj.filter(body, { sender, from, message: msg });
          if (matched) {
            const executeFn = cmdObj.handler || cmdObj.execute;
            if (executeFn) {
              const q = body.trim();
              await executeFn(sock, msg, [q], {
                from, sender, isGroup, groupMetadata,
                body: q,
                isOwner: isOwner(sender, sock),
                isAdmin: false, isBotAdmin: false, isMod: isMod(sender),
                reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }).catch(() => {}),
                react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {})
              });
              return;
            }
          }
        }
      }
    } catch (filterErr) {
      console.error('Filter command error:', filterErr);
    }
    // ── End Filter Commands ────────────────────────────────────────

    // ── Auto-Reply ───────────────────────────────────────────────
    try {
      const arRaw = effectiveSettings.autoReply ?? globalSettings.autoReply;
      const arCfg = (arRaw && typeof arRaw === 'object') ? arRaw : null;
      if (arCfg?.enabled && !msg.key.fromMe && body && body.trim()) {
        const msgLower = body.toLowerCase().trim();
        let arReply = null;

        // Keyword matching — always active in all modes, highest priority
        if (arCfg.keywords?.length) {
          const hit = arCfg.keywords.find(k => msgLower.includes(k.keyword.toLowerCase()));
          if (hit) arReply = hit.response;
        }

        if (!arReply) {
          if (arCfg.mode === 'smart') {
            // Smart mode: pick a random natural reply from the messages list
            const pool = (arCfg.messages && arCfg.messages.length)
              ? arCfg.messages
              : [arCfg.message || "Hi! How can I assist you today? 😊"];
            arReply = pool[Math.floor(Math.random() * pool.length)];

          } else if (arCfg.mode !== 'custom') {
            // AI modes
            let shouldReply = false;
            if (arCfg.mode === 'ai-always') {
              shouldReply = true;
            } else if (arCfg.mode === 'ai-time') {
              const now = new Date();
              const [sh, sm] = (arCfg.timeStart || '09:00').split(':').map(Number);
              const [eh, em] = (arCfg.timeEnd   || '18:00').split(':').map(Number);
              const nowM   = now.getHours() * 60 + now.getMinutes();
              const startM = sh * 60 + sm;
              const endM   = eh * 60 + em;
              shouldReply  = nowM >= startM && nowM <= endM;
            } else if (arCfg.mode === 'ai-offline') {
              shouldReply = true;
            }

            if (shouldReply) {
              // Try AI command for ai-* modes
              if (arCfg.mode !== 'ai-offline') {
                const aiCmd = commands.get('ai') || commands.get('gpt') || commands.get('chat') || cmdRegistry.get('ai') || cmdRegistry.get('gpt');
                if (aiCmd) {
                  try {
                    const fn = aiCmd.handler || aiCmd.execute;
                    if (fn) {
                      await fn(sock, msg, body.split(' '), {
                        from, sender, isGroup, groupMetadata,
                        isOwner: isOwner(sender, sock),
                        isAdmin: false, isBotAdmin: false, isMod: isMod(sender),
                        reply: (t) => sock.sendMessage(from, { text: t }, { quoted: msg }).catch(() => {}),
                        react: (e) => sock.sendMessage(from, { react: { text: e, key: msg.key } }).catch(() => {})
                      });
                      return;
                    }
                  } catch (e) { /* fall through to fallback message */ }
                }
              }
              arReply = arCfg.message || "Hi! I'm a bit busy right now. I'll get back to you soon! 😊";
            }
          }
        }

        if (arReply) {
          await sock.sendMessage(from, { text: arReply }, { quoted: msg }).catch(() => {});
          return;
        }
      }
    } catch (arErr) {
      console.error('Auto-reply error:', arErr);
    }
    // ── End Auto-Reply ──────────────────────────────────────────

    // Group Protections
    if (isGroup) {
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.antiall && !isOwner(sender) && !(await isAdmin(sock, sender, from, groupMetadata))) {
        if (await isBotAdmin(sock, from, groupMetadata)) {
          await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
          return;
        }
      }
      
      if (groupSettings.antitag && !msg.key.fromMe) {
        const ctx = content.extendedTextMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];
        const messageText = body || content.imageMessage?.caption || content.videoMessage?.caption || '';
        const numericMentions = messageText.match(/@\d{10,}/g) || [];
        const uniqueNumericMentions = new Set();
        numericMentions.forEach((mention) => {
          const numMatch = mention.match(/@(\d+)/);
          if (numMatch) uniqueNumericMentions.add(numMatch[1]);
        });
        const totalMentions = Math.max(mentionedJids.length, uniqueNumericMentions.size);
        
        if (totalMentions >= 3) {
          const participants = groupMetadata.participants || [];
          const mentionThreshold = Math.max(3, Math.ceil(participants.length * 0.5));
          if (totalMentions >= mentionThreshold || uniqueNumericMentions.size >= 10) {
            const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
            if (!senderIsAdmin && !isOwner(sender)) {
              const action = (groupSettings.antitagAction || 'delete').toLowerCase();
              if (action === 'delete' || action === 'kick') {
                await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
              }
              if (action === 'kick' && await isBotAdmin(sock, from, groupMetadata)) {
                await sock.groupParticipantsUpdate(from, [sender], 'remove').catch(() => {});
                await sock.sendMessage(from, { text: `🚫 *Antitag Detected!*\n@${sender.split('@')[0]} has been kicked.`, mentions: [sender] }).catch(() => {});
              }
            }
          }
        }
      }

      if (groupSettings.antigroupmention) {
        await handleAntigroupmention(sock, msg, groupMetadata).catch(() => {});
      }

      if (groupSettings.autosticker) {
        const mediaMessage = content?.imageMessage || content?.videoMessage;
        if (mediaMessage && !body.startsWith(config.prefix)) {
          const stickerCmd = commands.get('sticker');
          if (stickerCmd) {
            await stickerCmd.execute(sock, msg, [], {
              from, sender, isGroup, groupMetadata, isOwner: isOwner(sender),
              isAdmin: await isAdmin(sock, sender, from, groupMetadata),
              isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
              isMod: isMod(sender),
              reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }).catch(() => {}),
              react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {})
            }).catch(() => {});
            return;
          }
        }
      }

      // ── AntiBadAI ─────────────────────────────────────────────────────────
      if (groupSettings.antibadai && !msg.key.fromMe) {
        // Collect ALL text from every message type (text, captions, filenames)
        const allText = [
          body,
          content.documentMessage?.caption,
          content.documentMessage?.fileName,
          content.imageMessage?.caption,
          content.videoMessage?.caption,
        ].filter(t => t && t.trim().length > 0).join(' ').trim();

        if (allText.length > 1) {
          const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
          if (!senderIsAdmin && !isOwner(sender)) {
            // Check bot has admin rights BEFORE wasting an AI call
            const botHasAdmin = await isBotAdmin(sock, from, groupMetadata);
            if (botHasAdmin) {
              try {
                const axios = require('axios');
                const checkPrompt = `You are a content moderation AI. Your job is to detect harmful content in ANY language (English, Sinhala, Tamil, Arabic, etc.). Reply with ONLY the word "BAD" if the message contains ANY of: profanity, swear words, hate speech, sexual content, slurs, insults, threats, or offensive language. Reply with ONLY "OK" if the message is clean. Do NOT explain. Message: "${allText.replace(/"/g, "'").substring(0, 300)}"`;
                const aiRes = await axios.get(
                  `https://api.shizo.top/ai/gpt?apikey=shizo&query=${encodeURIComponent(checkPrompt)}`,
                  { timeout: 10000 }
                );
                const verdict = (aiRes.data?.msg || aiRes.data?.result || '').toString().trim().toUpperCase();
                if (verdict.startsWith('BAD')) {
                  await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                  const senderNum = sender.split('@')[0];
                  await sock.sendMessage(from, {
                    text: `🤖 *AntiBadAI*\n\n⚠️ Inappropriate message from @${senderNum} has been removed.\n_This group has bad word detection enabled._`,
                    mentions: [sender]
                  }).catch(() => {});
                }
              } catch (e) {
                // AI check failed silently — message left as-is
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in message handler:', error);
    if (!error.message?.includes('rate-overlimit') && !error.message?.includes('Connection Closed')) {
      try {
        await sock.sendMessage(msg.key.remoteJid, { text: `❌ *Error:*\n${error.message}` }, { quoted: msg }).catch(() => {});
      } catch (e) {}
    }
  }
};

// Group participant update handler
const handleGroupUpdate = async (sock, update) => {
  try {
    const { id, participants, action } = update;
    
    // Validate group JID before processing
    if (!id || !id.endsWith('@g.us')) {
      return;
    }
    
    const groupSettings = database.getGroupSettings(id);
    
    if (!groupSettings.welcome && !groupSettings.goodbye) return;
    
    const groupMetadata = await getGroupMetadata(sock, id);
    if (!groupMetadata) return; // Skip if metadata unavailable (forbidden or error)
    
    // Helper to extract participant JID
    const getParticipantJid = (participant) => {
      if (typeof participant === 'string') {
        return participant;
      }
      if (participant && participant.id) {
        return participant.id;
      }
      if (participant && typeof participant === 'object') {
        // Try to find JID in object
        return participant.jid || participant.participant || null;
      }
      return null;
    };
    
    for (const participant of participants) {
      const participantJid = getParticipantJid(participant);
      if (!participantJid) {
        console.warn('Could not extract participant JID:', participant);
        continue;
      }
      
      const participantNumber = participantJid.split('@')[0];
      
      if (action === 'add' && groupSettings.welcome) {
        try {
          // Get user's display name - find participant using phoneNumber or JID
          let displayName = participantNumber;
          
          // Try to find participant in group metadata
          const participantInfo = groupMetadata.participants.find(p => {
            const pId = p.id || p.jid || p.participant;
            const pPhone = p.phoneNumber;
            // Match by JID or phoneNumber
            return pId === participantJid || 
                   pId?.split('@')[0] === participantNumber ||
                   pPhone === participantJid ||
                   pPhone?.split('@')[0] === participantNumber;
          });
          
          // Get phoneNumber JID to fetch contact name
          let phoneJid = null;
          if (participantInfo && participantInfo.phoneNumber) {
            phoneJid = participantInfo.phoneNumber;
          } else {
            // Try to normalize participantJid to phoneNumber format
            // If it's a LID, try to convert to phoneNumber
            try {
              const normalized = normalizeJidWithLid(participantJid);
              if (normalized && normalized.includes('@s.whatsapp.net')) {
                phoneJid = normalized;
              }
            } catch (e) {
              // If normalization fails, try using participantJid directly if it's a valid JID
              if (participantJid.includes('@s.whatsapp.net')) {
                phoneJid = participantJid;
              }
            }
          }
          
          // Try to get contact name from phoneNumber JID
          if (phoneJid) {
            try {
              // Method 1: Try to get from contact store if available
              if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                const contact = sock.store.contacts[phoneJid];
                if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                  displayName = contact.notify.trim();
                } else if (contact.name && contact.name.trim() && !contact.name.match(/^\d+$/)) {
                  displayName = contact.name.trim();
                }
              }
              
              // Method 2: Try to fetch contact using onWhatsApp and then check store
              if (displayName === participantNumber) {
                try {
                  await sock.onWhatsApp(phoneJid);
                  
                  // After onWhatsApp, check store again (might populate after check)
                  if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                    const contact = sock.store.contacts[phoneJid];
                    if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                      displayName = contact.notify.trim();
                    }
                  }
                } catch (fetchError) {
                  // Silently handle fetch errors
                }
              }
            } catch (contactError) {
              // Silently handle contact errors
            }
          }
          
          // Final fallback: use participantInfo.notify or name if available
          if (displayName === participantNumber && participantInfo) {
            if (participantInfo.notify && participantInfo.notify.trim() && !participantInfo.notify.match(/^\d+$/)) {
              displayName = participantInfo.notify.trim();
            } else if (participantInfo.name && participantInfo.name.trim() && !participantInfo.name.match(/^\d+$/)) {
              displayName = participantInfo.name.trim();
            }
          }
          
          // Get user's profile picture URL
          let profilePicUrl = '';
          try {
            profilePicUrl = await sock.profilePictureUrl(participantJid, 'image');
          } catch (ppError) {
            // If profile picture not available, use default avatar
            profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
          }
          
          // Get group name and description
          const groupName = groupMetadata.subject || 'the group';
          const groupDesc = groupMetadata.desc || 'No description';
          
          // Get current time string
          const now = new Date();
          const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
          });
          
          // Create formatted welcome message
          const welcomeMsg = `╭╼━≪•𝙽𝙴𝚆 𝙼𝙴𝙼𝙱𝙴𝚁•≫━╾╮\n┃𝚆𝙴𝙻𝙲𝙾𝙼𝙴: @${displayName} 👋\n┃Member count: #${groupMetadata.participants.length}\n┃𝚃𝙸𝙼𝙴: ${timeString}⏰\n╰━━━━━━━━━━━━━━━╯\n\n*@${displayName}* Welcome to *${groupName}*! 🎉\n*Group 𝙳𝙴𝚂𝙲𝚁𝙸𝙿𝚃𝙸𝙾𝙽*\n${groupDesc}\n\n> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ${config.botName}*`;
          
          // Construct API URL for welcome image
          const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=join&textcolor=white&username=${encodeURIComponent(displayName)}&guildName=${encodeURIComponent(groupName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(profilePicUrl)}`;
          
          // Download the welcome image
          const imageResponse = await axios.get(apiUrl, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data);
          
          // Send the welcome image with formatted caption
          await sock.sendMessage(id, { 
            image: imageBuffer,
            caption: welcomeMsg,
            mentions: [participantJid] 
          });
        } catch (welcomeError) {
          // Fallback to text message if image generation fails
          console.error('Welcome image error:', welcomeError);
          let message = groupSettings.welcomeMessage || 'Welcome @user to @group! 👋\nEnjoy your stay!';
          message = message.replace('@user', `@${participantNumber}`);
          message = message.replace('@group', groupMetadata.subject || 'the group');
          
          await sock.sendMessage(id, { 
            text: message, 
            mentions: [participantJid] 
          });
        }
      } else if (action === 'remove' && groupSettings.goodbye) {
        try {
          // Get user's display name - find participant using phoneNumber or JID
          let displayName = participantNumber;
          
          // Try to find participant in group metadata (before they left)
          const participantInfo = groupMetadata.participants.find(p => {
            const pId = p.id || p.jid || p.participant;
            const pPhone = p.phoneNumber;
            // Match by JID or phoneNumber
            return pId === participantJid || 
                   pId?.split('@')[0] === participantNumber ||
                   pPhone === participantJid ||
                   pPhone?.split('@')[0] === participantNumber;
          });
          
          // Get phoneNumber JID to fetch contact name
          let phoneJid = null;
          if (participantInfo && participantInfo.phoneNumber) {
            phoneJid = participantInfo.phoneNumber;
          } else {
            // Try to normalize participantJid to phoneNumber format
            try {
              const normalized = normalizeJidWithLid(participantJid);
              if (normalized && normalized.includes('@s.whatsapp.net')) {
                phoneJid = normalized;
              }
            } catch (e) {
              if (participantJid.includes('@s.whatsapp.net')) {
                phoneJid = participantJid;
              }
            }
          }
          
          // Try to get contact name from phoneNumber JID
          if (phoneJid) {
            try {
              // Method 1: Try to get from contact store if available
              if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                const contact = sock.store.contacts[phoneJid];
                if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                  displayName = contact.notify.trim();
                } else if (contact.name && contact.name.trim() && !contact.name.match(/^\d+$/)) {
                  displayName = contact.name.trim();
                }
              }
              
              // Method 2: Try to fetch contact using onWhatsApp and then check store
              if (displayName === participantNumber) {
                try {
                  await sock.onWhatsApp(phoneJid);
                  
                  // After onWhatsApp, check store again
                  if (sock.store && sock.store.contacts && sock.store.contacts[phoneJid]) {
                    const contact = sock.store.contacts[phoneJid];
                    if (contact.notify && contact.notify.trim() && !contact.notify.match(/^\d+$/)) {
                      displayName = contact.notify.trim();
                    }
                  }
                } catch (fetchError) {
                  // Silently handle fetch errors
                }
              }
            } catch (contactError) {
              // Silently handle contact errors
            }
          }
          
          // Final fallback: use participantInfo.notify or name if available
          if (displayName === participantNumber && participantInfo) {
            if (participantInfo.notify && participantInfo.notify.trim() && !participantInfo.notify.match(/^\d+$/)) {
              displayName = participantInfo.notify.trim();
            } else if (participantInfo.name && participantInfo.name.trim() && !participantInfo.name.match(/^\d+$/)) {
              displayName = participantInfo.name.trim();
            }
          }
          
          // Get user's profile picture URL
          let profilePicUrl = '';
          try {
            profilePicUrl = await sock.profilePictureUrl(participantJid, 'image');
          } catch (ppError) {
            // If profile picture not available, use default avatar
            profilePicUrl = 'https://img.pyrocdn.com/dbKUgahg.png';
          }
          
          // Get group name and description
          const groupName = groupMetadata.subject || 'the group';
          const groupDesc = groupMetadata.desc || 'No description';
          
          // Get current time string
          const now = new Date();
          const timeString = now.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: true 
          });
          
          // Create simple goodbye message
          const goodbyeMsg = `Goodbye @${displayName} 👋 We will never miss you!`;
          
          // Construct API URL for goodbye image (using leave type)
          const apiUrl = `https://api.some-random-api.com/welcome/img/7/gaming4?type=leave&textcolor=white&username=${encodeURIComponent(displayName)}&guildName=${encodeURIComponent(groupName)}&memberCount=${groupMetadata.participants.length}&avatar=${encodeURIComponent(profilePicUrl)}`;
          
          // Download the goodbye image
          const imageResponse = await axios.get(apiUrl, { responseType: 'arraybuffer' });
          const imageBuffer = Buffer.from(imageResponse.data);
          
          // Send the goodbye image with caption
          await sock.sendMessage(id, { 
            image: imageBuffer,
            caption: goodbyeMsg,
            mentions: [participantJid] 
          });
        } catch (goodbyeError) {
          // Fallback to simple goodbye message
          console.error('Goodbye error:', goodbyeError);
          const goodbyeMsg = `Goodbye @${participantNumber} 👋 We will never miss you! 💀`;
          
          await sock.sendMessage(id, { 
            text: goodbyeMsg, 
            mentions: [participantJid] 
          });
        }
      }
    }
  } catch (error) {
    // Silently handle forbidden errors and other group metadata errors
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Silently skip forbidden groups
      return;
    }
    // Only log non-forbidden errors
    if (!error.message || !error.message.includes('forbidden')) {
      console.error('Error handling group update:', error);
    }
  }
};

// Antilink handler
const handleAntilink = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antilink) return;
    
    const body = msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.imageMessage?.caption || 
                  msg.message?.videoMessage?.caption || '';
    
    // Comprehensive link detection - matches links with or without protocols
    // Matches: https://t.me/..., http://wa.me/..., t.me/..., wa.me/..., google.com, telegram.com, etc.
    // Pattern breakdown:
    // 1. (https?:\/\/)? - Optional http:// or https://
    // 2. ([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.)+[a-zA-Z]{2,} - Domain pattern (e.g., google.com, t.me)
    // 3. (\/[^\s]*)? - Optional path after domain
    const linkPattern = /(https?:\/\/)?([a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]*\.)+[a-zA-Z]{2,}(\/[^\s]*)?/i;
    
    // Check for any links (with or without protocol)
    if (linkPattern.test(body)) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = isOwner(sender);
      
      if (senderIsAdmin || senderIsOwner) return;
      
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      const action = (groupSettings.antilinkAction || 'delete').toLowerCase();
      
      if (action === 'kick' && botIsAdmin) {
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          await sock.sendMessage(from, { 
            text: `🔗 Anti-link triggered. Link removed.`,
            mentions: [sender]
          }, { quoted: msg });
        } catch (e) {
          console.error('Failed to kick for antilink:', e);
        }
      } else {
        // Default: delete message
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.sendMessage(from, { 
            text: `🔗 Anti-link triggered. Link removed.`,
            mentions: [sender]
          }, { quoted: msg });
        } catch (e) {
          console.error('Failed to delete message for antilink:', e);
        }
      }
    }
  } catch (error) {
    console.error('Error in antilink handler:', error);
  }
};


// Anti-group mention handler
const handleAntigroupmention = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    
    // Debug logging to confirm handler is being called
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Log simplified message info instead of full structure to avoid huge logs
      // Debug log removed
    }
    
    if (!groupSettings.antigroupmention) return;
    
    // Check if this is a forwarded status message that mentions the group
    // Comprehensive detection for various status mention message types
    let isForwardedStatus = false;
    
    if (msg.message) {
      // Direct checks for known status mention message types
      isForwardedStatus = isForwardedStatus || !!msg.message.groupStatusMentionMessage;
      isForwardedStatus = isForwardedStatus || 
        (msg.message.protocolMessage && msg.message.protocolMessage.type === 25); // STATUS_MENTION_MESSAGE
      
      // Check for forwarded newsletter info in various message types
      isForwardedStatus = isForwardedStatus || 
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && 
         msg.message.extendedTextMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.conversation && msg.message.contextInfo && 
         msg.message.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.imageMessage && msg.message.imageMessage.contextInfo && 
         msg.message.imageMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.videoMessage && msg.message.videoMessage.contextInfo && 
         msg.message.videoMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.contextInfo && msg.message.contextInfo.forwardedNewsletterMessageInfo);
      
      // Generic check for any forwarded message
      if (msg.message.contextInfo) {
        const ctx = msg.message.contextInfo;
        isForwardedStatus = isForwardedStatus || !!ctx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!ctx.forwardingScore;
        // Additional check for forwarded status specifically
        isForwardedStatus = isForwardedStatus || !!ctx.quotedMessageTimestamp;
      }
      
      // Additional checks for forwarded messages
      if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
        const extCtx = msg.message.extendedTextMessage.contextInfo;
        isForwardedStatus = isForwardedStatus || !!extCtx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!extCtx.forwardingScore;
      }
    }
    
    // Additional debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    // Additional debug logging to help identify message structure
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Debug log removed
      if (msg.message) {
        // Debug log removed
        // Log specific message types that might indicate a forwarded status
        if (msg.message.protocolMessage) {
          // Debug log removed
        }
        if (msg.message.contextInfo) {
          // Debug log removed
        }
        if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
          // Debug log removed
        }
      }
    }
    
    // Debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    if (isForwardedStatus) {
      if (groupSettings.antigroupmention) {
        // Process forwarded status message
      }
      
      const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = isOwner(sender);
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      // Don't act on admins or owners
      if (senderIsAdmin || senderIsOwner) return;
      
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      const action = (groupSettings.antigroupmentionAction || 'delete').toLowerCase();
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      if (action === 'kick' && botIsAdmin) {
        try {
          if (groupSettings.antigroupmention) {
            // Delete and kick user
          }
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          // Silent removal
        } catch (e) {
          console.error('Failed to kick for antigroupmention:', e);
        }
      } else {
        // Default: delete message
        try {
          if (groupSettings.antigroupmention) {
            // Delete message
          }
          await sock.sendMessage(from, { delete: msg.key });
          // Silent deletion
        } catch (e) {
          console.error('Failed to delete message for antigroupmention:', e);
        }
      }
    } else if (groupSettings.antigroupmention) {
      // Debug log removed
    }
  } catch (error) {
    console.error('Error in antigroupmention handler:', error);
  }
};


// Anti-call feature initializer
const initializeAntiCall = (sock) => {
  // Anti-call feature - reject and block incoming calls
  sock.ev.on('call', async (calls) => {
    try {
      // Reload config to get fresh settings
      delete require.cache[require.resolve('./config')];
      const config = require('./config');
      
      if (!config.defaultGroupSettings.anticall) return;

      for (const call of calls) {
        if (call.status === 'offer') {
          // Reject the call
          await sock.rejectCall(call.id, call.from);

          // Block the caller
          await sock.updateBlockStatus(call.from, 'block');

          // Notify user
          await sock.sendMessage(call.from, {
            text: '🚫 Calls are not allowed. You have been blocked.'
          });
        }
      }
    } catch (err) {
      console.error('[ANTICALL ERROR]', err);
    }
  });
};

module.exports = {
  handleMessage,
  handleGroupUpdate,
  handleAntilink,
  handleAntigroupmention,
  initializeAntiCall,
  isOwner,
  isAdmin,
  isBotAdmin,
  isMod,
  getGroupMetadata,
  findParticipant
};
