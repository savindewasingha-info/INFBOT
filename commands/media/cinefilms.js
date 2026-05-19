const { cmd } = require("../../command");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const vm = require("vm");
const CryptoJS = require("crypto-js");
const protobuf = require("protobufjs");
const { sendBtn, btn } = require("../../utils/sendBtn");

// Patch Baileys upload timeout from 30s → 30 minutes so large files can upload
try {
  const baileys = require("@whiskeysockets/baileys");
  if (baileys.UPLOAD_TIMEOUT !== undefined) baileys.UPLOAD_TIMEOUT = 30 * 60 * 1000;
} catch (_) {}

// Global State (separate namespace from film.js)
global.pendingCineFilm = global.pendingCineFilm || {};
global.activeCineDownloads = global.activeCineDownloads || new Set();
global.cineDownloadQueue = global.cineDownloadQueue || [];

// Design / Config
const LOGO_URL = "https://files.catbox.moe/2jt3ln.png";
const BASE_URL = "https://cinesubz.net";
const SEARCH_API = "https://cinesubz.net/wp-json/zetaflix/search/";
const NEW_URL = "https://cinesubz.net/genre/new/";
const DOWNLOAD_HIGH_WATER_MARK = 2 * 1024 * 1024;
const MAX_MOVIE_DOWNLOADS = Math.max(1, Number(process.env.MAX_MOVIE_DOWNLOADS) || 1);
const MOVIE_UPLOAD_MAX_MB = Math.max(10, Number(process.env.MOVIE_UPLOAD_MAX_MB) || 64);
const MOVIE_UPLOAD_MAX_BYTES = MOVIE_UPLOAD_MAX_MB * 1024 * 1024;
const MOVIE_SPLIT_MAX_MB = Math.max(MOVIE_UPLOAD_MAX_MB, Number(process.env.MOVIE_SPLIT_MAX_MB) || MOVIE_UPLOAD_MAX_MB * 3);
const MOVIE_SPLIT_MAX_BYTES = MOVIE_SPLIT_MAX_MB * 1024 * 1024;

const downloadHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const downloadHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
const QUALITY_ORDER = { "1080p": 3, "720p": 2, "480p": 1 };

// Nonce cache for the zetaflix search API
let _nonceCache = null;
let _nonceCacheAt = 0;
const NONCE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── URL Mappings (extracted from cinesubz zt-links page JS) ──────────────────
const CINE_URL_MAPPINGS = [
  {
    search: ["https://google.com/server11/1:/", "https://google.com/server12/1:/", "https://google.com/server13/1:/"],
    replace: "https://bot3.sonic-cloud.online/server1/"
  },
  {
    search: ["https://google.com/server21/1:/", "https://google.com/server22/1:/", "https://google.com/server23/1:/"],
    replace: "https://bot3.sonic-cloud.online/server2/"
  },
  { search: ["https://google.com/server3/1:/"], replace: "https://bot3.sonic-cloud.online/server3/" },
  { search: ["https://google.com/server4/1:/"], replace: "https://bot3.sonic-cloud.online/server4/" },
  { search: ["https://google.com/server5/1:/"], replace: "https://bot3.sonic-cloud.online/server5/" },
  { search: ["https://google.com/server6/"],    replace: "https://bot3.sonic-cloud.online/server6/" },
];

function transformCineSubzUrl(rawUrl) {
  if (!rawUrl) return null;
  let url = rawUrl;
  for (const mapping of CINE_URL_MAPPINGS) {
    for (const prefix of mapping.search) {
      if (url.startsWith(prefix)) {
        url = url.replace(prefix, mapping.replace);
        // Extension handling (mirrors the site's own JS)
        if (url.includes(".mp4?bot=cscloud2bot&code=")) {
          url = url.replace(".mp4?bot=cscloud2bot&code=", "?ext=mp4&bot=cscloud2bot&code=");
        } else if (url.includes(".mp4")) {
          url = url.replace(".mp4", "?ext=mp4");
        } else if (url.includes(".mkv?bot=cscloud2bot&code=")) {
          url = url.replace(".mkv?bot=cscloud2bot&code=", "?ext=mkv&bot=cscloud2bot&code=");
        } else if (url.includes(".mkv")) {
          url = url.replace(".mkv", "?ext=mkv");
        } else if (url.includes(".zip")) {
          url = url.replace(".zip", "?ext=zip");
        }
        return url;
      }
    }
  }
  return url;
}

// ─── Direct HTTP helper ────────────────────────────────────────────────────────
async function cineFetch(url, opts = {}) {
  return axios.get(url, {
    timeout: 30000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      ...opts.headers
    },
    validateStatus: s => s < 400,
    decompress: true,
    ...opts
  });
}

// ─── Nonce fetch ───────────────────────────────────────────────────────────────
async function getNonce() {
  if (_nonceCache && Date.now() - _nonceCacheAt < NONCE_TTL) return _nonceCache;
  const { data } = await cineFetch(BASE_URL + "/");
  const match = String(data).match(/"nonce"\s*:\s*"([a-f0-9]+)"/);
  if (match) {
    _nonceCache = match[1];
    _nonceCacheAt = Date.now();
    return _nonceCache;
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeQuality(text) {
  if (!text) return "Unknown";
  const t = text.toUpperCase();
  if (/1080|FHD/.test(t)) return "1080p";
  if (/720|HD/.test(t)) return "720p";
  if (/480|SD/.test(t)) return "480p";
  return text.split("•")[0].trim() || text;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60), s = Math.ceil(seconds % 60);
  return `${m}m ${s}s`;
}

function renderProgressBar(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * 20);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${p}%`;
}

function renderMovieProgress({ title, quality, size, percent, downloadPercent, uploadPercent, stage, downloadedBytes, totalBytes, speedBytesPerSecond, startedAt }) {
  const dlPct = downloadPercent ?? percent ?? 0;
  const ulPct = uploadPercent ?? 0;
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const downloaded = formatBytes(downloadedBytes);
  const total = formatBytes(totalBytes);
  const speed = formatBytes(speedBytesPerSecond);
  let eta = "";
  if (speedBytesPerSecond > 0 && totalBytes > 0 && downloadedBytes > 0 && dlPct < 100) {
    eta = formatEta((totalBytes - downloadedBytes) / speedBytesPerSecond);
  }
  const progressLine = downloaded && total
    ? `${downloaded} / ${total}${speed ? "  •  " + speed + "/s" : ""}${eta ? "  •  ⏳ " + eta : ""}`
    : size;
  const isUploading = dlPct >= 100;
  return (
    `╭─────────────────────────╮\n` +
    `│  📥 *Downloading Movie*\n` +
    `│\n` +
    `│  🎬 ${title}\n` +
    `│  📊 ${quality}  •  ${size}\n` +
    `│\n` +
    (isUploading
      ? `│  ⬆️ *Sending to chat...*\n` +
        `│  ${renderProgressBar(ulPct)}\n`
      : `│  ⬇️ *Downloading...*\n` +
        `│  ${renderProgressBar(dlPct)}\n` +
        (progressLine ? `│  ${progressLine}\n` : "")
    ) +
    `│\n` +
    `│  ⏱️ ${elapsed}s  •  ${stage}\n` +
    `╰─────────────────────────╯`
  );
}

async function getVideoDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", filePath]);
  return parseFloat(JSON.parse(stdout).format.duration);
}

async function splitVideoWithFfmpeg(inputPath, partCount, baseTitle) {
  const duration = await getVideoDuration(inputPath);
  const partDuration = duration / partCount;
  const partPaths = [];
  for (let i = 0; i < partCount; i++) {
    const partPath = `/tmp/cmovie_part${String(i + 1).padStart(2, "0")}of${String(partCount).padStart(2, "0")}_${Date.now()}.mp4`;
    await execFileAsync("ffmpeg", [
      "-ss", String(i * partDuration), "-i", inputPath,
      "-t", String(partDuration), "-c", "copy",
      "-avoid_negative_ts", "1", "-y", partPath
    ], { maxBuffer: 10 * 1024 * 1024 });
    partPaths.push(partPath);
  }
  return partPaths;
}

async function downloadMovieToFile(url, tempPath, onProgress) {
  const response = await axios({
    method: "GET", url,
    responseType: "stream",
    timeout: 0, maxRedirects: 10,
    maxBodyLength: Infinity, maxContentLength: Infinity,
    decompress: false,
    httpAgent: downloadHttpAgent, httpsAgent: downloadHttpsAgent,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "*/*", "Accept-Encoding": "identity",
      "Connection": "keep-alive",
      "Referer": "https://cinesubz.net",
      "Origin": "https://cinesubz.net"
    },
    validateStatus: status => status >= 200 && status < 400
  });

  const totalBytes = Number(response.headers["content-length"]) || 0;
  const startedAt = Date.now();
  let downloadedBytes = 0, lastProgressAt = 0;

  const { Transform } = require("stream");
  const progressTransform = new Transform({
    highWaterMark: DOWNLOAD_HIGH_WATER_MARK,
    transform(chunk, _, callback) {
      downloadedBytes += chunk.length;
      const now = Date.now();
      if (now - lastProgressAt >= 250 || downloadedBytes === totalBytes) {
        lastProgressAt = now;
        const seconds = Math.max(1, (now - startedAt) / 1000);
        const percent = totalBytes
          ? Math.min(85, (downloadedBytes / totalBytes) * 85)
          : Math.min(85, 5 + (downloadedBytes / (1024 * 1024 * 1024)) * 80);
        onProgress({ downloadPercent: percent, downloadedBytes, totalBytes, speedBytesPerSecond: downloadedBytes / seconds });
      }
      callback(null, chunk);
    }
  });

  await pipeline(response.data, progressTransform, fs.createWriteStream(tempPath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK }));

  const savedSize = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0;
  if (!savedSize) throw new Error("Downloaded file is empty. The link may be expired or the file was removed.");
  if (totalBytes && Math.abs(downloadedBytes - totalBytes) > 1024) {
    throw new Error(`Incomplete download (${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)})`);
  }
  return { downloadedBytes: savedSize, totalBytes: totalBytes || savedSize };
}

async function copyRangeToPart(sourcePath, partPath, start, end) {
  await pipeline(
    fs.createReadStream(sourcePath, { start, end, highWaterMark: DOWNLOAD_HIGH_WATER_MARK }),
    fs.createWriteStream(partPath, { highWaterMark: DOWNLOAD_HIGH_WATER_MARK })
  );
}

async function sendSplitMovieParts(sock, chatId, quoted, sourcePath, baseFileName, baseCaption, totalSize, progress, partSize) {
  const bytesPerPart = partSize || MOVIE_UPLOAD_MAX_BYTES;
  const partCount = Math.ceil(totalSize / bytesPerPart);
  const partPaths = [];
  let uploadTimer = null;
  try {
    await sock.sendMessage(chatId, {
      text:
        `╭─────────────────────────╮\n` +
        `│  📦 *Sending in ${partCount} Parts*\n` +
        `│\n` +
        `│  Each part: ~${formatBytes(bytesPerPart)}\n` +
        `│\n` +
        `│  ⚠️ *How to watch:*\n` +
        `│  1. Download all ${partCount} parts\n` +
        `│  2. Join them using HJSplit (Windows)\n` +
        `│     or: cat part1 part2 > movie.mp4\n` +
        `│  3. Open the joined .mp4 file\n` +
        `╰─────────────────────────╯`
    }, { quoted });

    for (let index = 0; index < partCount; index++) {
      const partNumber = index + 1;
      const start = index * bytesPerPart;
      const end = Math.min(totalSize - 1, start + bytesPerPart - 1);
      const partPath = `${sourcePath}.part${String(partNumber).padStart(2, "0")}of${String(partCount).padStart(2, "0")}`;
      const partFileName = `${baseFileName}.part${String(partNumber).padStart(2, "0")}of${String(partCount).padStart(2, "0")}`;
      partPaths.push(partPath);

      const basePercent = Math.round((index / partCount) * 100);
      let prepPercent = basePercent;
      progress.update({ uploadPercent: prepPercent, stage: `Preparing part ${partNumber}/${partCount}...` });

      const prepTimer = setInterval(() => {
        prepPercent = Math.min(basePercent + Math.round(100 / partCount) - 2, prepPercent + 1);
        progress.update({ uploadPercent: prepPercent, stage: `Preparing part ${partNumber}/${partCount}...` });
      }, 400);

      await copyRangeToPart(sourcePath, partPath, start, end);
      clearInterval(prepTimer);

      let currentPartPercent = 0;
      uploadTimer = setInterval(() => {
        currentPartPercent = Math.min(95, currentPartPercent + 2);
        const totalUploadPercent = ((index + currentPartPercent / 100) / partCount) * 100;
        progress.update({ uploadPercent: totalUploadPercent, stage: `Uploading part ${partNumber}/${partCount}...` });
      }, 1000);

      await sock.sendMessage(chatId, {
        document: { url: partPath },
        mimetype: "application/octet-stream",
        fileName: partFileName,
        caption:
          `${baseCaption}\n\n━━━━━━━━━━━━━━━━━━━━\n` +
          `📦 Part *${partNumber} of ${partCount}*\n` +
          `📏 Size: ${formatBytes(end - start + 1)}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `_Download all ${partCount} parts and join them before watching._`
      }, { quoted });

      clearInterval(uploadTimer);
      uploadTimer = null;
      if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
      progress.update({ uploadPercent: Math.round((partNumber / partCount) * 100), stage: `Part ${partNumber}/${partCount} sent.` });
    }
  } finally {
    if (uploadTimer) clearInterval(uploadTimer);
    for (const p of partPaths) { if (fs.existsSync(p)) fs.unlinkSync(p); }
  }
}

async function sendLiveProgress(sock, chatId, quoted, initialState) {
  let state = { startedAt: Date.now(), ...initialState };
  let stopped = false, editing = false, lastText = "";
  const message = await sock.sendMessage(chatId, { text: renderMovieProgress(state) }, { quoted });

  const edit = async (force = false) => {
    if (stopped || !message?.key) return;
    if (editing) {
      if (!force) return;
      while (editing) await new Promise(r => setTimeout(r, 100));
      if (stopped) return;
    }
    editing = true;
    try {
      const text = renderMovieProgress(state);
      if (force || text !== lastText) { lastText = text; await sock.sendMessage(chatId, { text, edit: message.key }); }
    } catch (e) {
      console.error("CineFilm progress edit error:", e.message);
    } finally { editing = false; }
  };

  lastText = renderMovieProgress(state);
  const timer = setInterval(edit, 1000);

  return {
    update(nextState) { state = { ...state, ...nextState }; },
    async stop(finalState) {
      state = { ...state, ...finalState };
      clearInterval(timer);
      await edit(true);
      stopped = true;
    }
  };
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────
async function searchCineSubz(query) {
  // Try REST API with nonce first
  try {
    const nonce = await getNonce();
    if (nonce) {
      const { data } = await cineFetch(`${SEARCH_API}?s=${encodeURIComponent(query)}&nonce=${nonce}`, {
        headers: { "Accept": "application/json" }
      });
      if (Array.isArray(data) && data.length) {
        return data.slice(0, 8).map((item, i) => ({
          id: i + 1,
          title: item.post_title || item.title || String(item.name || ""),
          movieUrl: item.url || item.link || item.guid || "",
          thumbnail: item.image || item.thumbnail || ""
        })).filter(r => r.title && r.movieUrl);
      }
    }
  } catch (_) {}

  // Fallback: scrape the search results page
  const { data } = await cineFetch(`${BASE_URL}/?s=${encodeURIComponent(query)}`);
  const $ = cheerio.load(data);
  const results = [];

  // Collect all internal movie page links with titles from heading tags
  const seen = new Set();
  $("h2 a, h3 a, h4 a, .entry-title a").each((i, el) => {
    const href = $(el).attr("href") || "";
    const title = $(el).text().trim();
    if (href.includes("/movies/") && !seen.has(href) && title.length > 2) {
      seen.add(href);
      results.push({ id: results.length + 1, title, movieUrl: href, thumbnail: "" });
    }
  });

  // Also try any article/div that has a movie link
  if (!results.length) {
    $("article, .item, [class*=item]").each((i, el) => {
      const a = $(el).find("a[href*='/movies/']").first();
      const href = a.attr("href") || "";
      const title = (a.attr("title") || $(el).find("h2,h3,h4,.entry-title").first().text()).trim();
      if (href && title && !seen.has(href)) {
        seen.add(href);
        results.push({ id: results.length + 1, title, movieUrl: href, thumbnail: "" });
      }
    });
  }

  return results.slice(0, 8);
}

async function getNewReleases() {
  const { data } = await cineFetch(NEW_URL);
  const $ = cheerio.load(data);
  const results = [];
  const seen = new Set();

  $("h2 a, h3 a, .entry-title a").each((i, el) => {
    const href = $(el).attr("href") || "";
    const title = $(el).text().trim();
    if (href.includes("/movies/") && !seen.has(href) && title.length > 2) {
      seen.add(href);
      const img = $(el).closest("article, .item").find("img").first();
      const thumbnail = img.attr("data-src") || img.attr("src") || "";
      results.push({ id: results.length + 1, title, movieUrl: href, thumbnail });
    }
  });

  if (!results.length) {
    $("article, .item, [class*=item]").each((i, el) => {
      const a = $(el).find("a[href*='/movies/']").first();
      const href = a.attr("href") || "";
      const title = (a.attr("title") || $(el).find("h2,h3,h4").first().text()).trim();
      if (href && title && !seen.has(href)) {
        seen.add(href);
        results.push({ id: results.length + 1, title, movieUrl: href, thumbnail: "" });
      }
    });
  }

  return results.slice(0, 8);
}

async function getMovieMetadata(movieUrl) {
  const { data } = await cineFetch(movieUrl);
  const $ = cheerio.load(data);

  const rawTitle = $(".details-title").text().trim();
  // Strip the "Sinhala Subtitles | ..." suffix for cleaner display
  const title = rawTitle.replace(/\s*\|.*$/, "").replace(/Sinhala Subtitles.*/i, "").trim() || rawTitle;

  const ratingText = $(".details-rating").first().text().trim();
  const imdb = ratingText.match(/([\d.]+)/)?.[1] || "N/A";

  const dataText = $(".details-data").text().trim();
  const duration = dataText.match(/(\d+\s*min)/i)?.[1] || "N/A";
  const qualityTag = dataText.match(/\b(WEB-?DL|BLURAY|HDTV|CAM|TS|DVD)\b/i)?.[1] || "";

  const genres = $(".details-genre a").map((i, el) => $(el).text().trim()).get()
    .filter(g => !g.startsWith(".") && !g.startsWith("#") && g !== "Updated");

  const infoText = $(".details-info").text().trim();
  const director = infoText.match(/Director:\s*([^\n]+?)(?:Country:|Year:|$)/)?.[1]?.trim() || "";
  const year = infoText.match(/Year:\s*(\d{4})/)?.[1] || "";
  const country = infoText.match(/Country:\s*([^\n]+?)(?:Year:|Subtitle|$)/)?.[1]?.trim() || "";
  const language = dataText.match(/\b(Hindi|Tamil|Telugu|English|Korean|Japanese|Sinhala|Bengali|Malayalam)\b/i)?.[1] || "N/A";

  const description = $(".details-desc").text().trim().slice(0, 200);
  const thumbnail = $("meta[property='og:image']").attr("content") || $(".splash-bg img").attr("src") || "";

  return { title, rawTitle, imdb, duration, qualityTag, genres, director, year, country, language, description, thumbnail };
}

async function getDownloadLinks(movieUrl) {
  const { data } = await cineFetch(movieUrl);
  const $ = cheerio.load(data);

  const items = [];
  $(".movie-download-link-item").each((i, el) => {
    const href = $(el).find("a").attr("href") || "";
    const metaText = $(el).find(".movie-download-meta").text().trim();
    // metaText looks like: "WEB-DL 720p • 1.5 GB • Hindi"
    if (href && metaText) {
      const parts = metaText.split("•").map(p => p.trim());
      const qualityRaw = parts[0] || "";
      const size = parts[1] || "";
      const lang = parts[2] || "";
      items.push({
        ztLink: href,
        quality: normalizeQuality(qualityRaw),
        size,
        lang,
        metaText
      });
    }
  });

  // Sort best quality first
  items.sort((a, b) => (QUALITY_ORDER[b.quality] || 0) - (QUALITY_ORDER[a.quality] || 0));
  return items;
}

// ─── CDN Proto Schema (static, encrypted with key "kasun") ───────────────────
const CDN_ENC_SCHEMA = "U2FsdGVkX1+CVcLAKUn+B9jJNjbj4hWoRKZqOjH78O2EHohZ9kRPcbq2hRrl9kx/7RhNrcZ7A+GjzyQaRmDPrORUo51NjzkskDIOVtOaYmBLQOcEEUQUqakDok5/nBKuO4+7pB1K7bmEYXaqeK6fGUXP3GeApIa2agVnQnTWZKuRZHBbzYAYZAIZq0hVxJmlUObvDk9H2vfdlyUWefysHQ==";

function cdnDecrypt(enc, key) {
  return CryptoJS.AES.decrypt(enc, key).toString(CryptoJS.enc.Utf8);
}
function cdnB64toUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

let _cdnDownloadData = null;
function getCdnProto() {
  if (_cdnDownloadData) return _cdnDownloadData;
  const schema = cdnB64toUtf8(cdnDecrypt(CDN_ENC_SCHEMA, "kasun"));
  const root = protobuf.parse(schema, { keepCase: true }).root;
  _cdnDownloadData = root.lookupType("responceEnc.DownloadData");
  return _cdnDownloadData;
}

async function resolveZtLink(ztUrl) {
  const CDN_UA = "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
  const noop = () => {};
  const pUrl = new URL(ztUrl);

  // Step 1: GET portal to obtain session cookie
  const r1 = await axios.get(ztUrl, { headers: { "User-Agent": CDN_UA }, timeout: 15000 });
  const cookieMap = {};
  (r1.headers["set-cookie"] || []).forEach(c => {
    const [k, ...v] = c.split(";")[0].split("=");
    cookieMap[k] = v.join("=");
  });

  // Step 2: GET /api/download-data to authenticate the session
  const authUrl = `https://bot3.sonic-cloud.online/api/download-data${pUrl.pathname}${pUrl.search}`;
  const r2 = await axios.get(authUrl, {
    headers: {
      "Cookie": Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; "),
      "User-Agent": CDN_UA,
      "Referer": ztUrl,
      "Origin": "https://bot3.sonic-cloud.online",
      "Accept": "application/json"
    },
    timeout: 15000,
    validateStatus: () => true
  });
  if (!r2.data?.success) throw new Error(`CDN auth failed: ${JSON.stringify(r2.data).slice(0, 80)}`);
  (r2.headers["set-cookie"] || []).forEach(c => {
    const [k, ...v] = c.split(";")[0].split("=");
    cookieMap[k] = v.join("=");
  });
  const sid = Object.entries(cookieMap).map(([k, v]) => `${k}=${v}`).join("; ");

  // Step 3: GET authenticated portal page (contains hex payload strings + obfuscated script)
  const r3 = await axios.get(ztUrl, {
    headers: { "Cookie": sid, "User-Agent": CDN_UA, "Accept": "text/html" },
    timeout: 15000
  });
  const hexList = [...new Set(
    [...r3.data.matchAll(/['"]([0-9a-f]{300,})['"]/gi)].map(m => m[1])
  )];
  if (!hexList.length) throw new Error("CDN: no hex payloads found on page");

  const scripts = r3.data.match(/<script[^>]*>([\s\S]*?)<\/script>/g) || [];
  const pageScript = scripts
    .map(s => s.replace(/<\/?script[^>]*>/g, ""))
    .sort((a, b) => b.length - a.length)[0] || "";
  if (pageScript.length < 5000) throw new Error("CDN: page script too small");

  // Step 4: POST with each hex payload until we get an encrypted protobuf response
  const DownloadData = getCdnProto();
  let encUrl = null;
  for (const hexStr of hexList) {
    try {
      const r = await axios.post(ztUrl, Buffer.from(hexStr, "hex"), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cookie": sid,
          "User-Agent": CDN_UA,
          "Referer": ztUrl,
          "Origin": "https://bot3.sonic-cloud.online"
        },
        timeout: 15000,
        validateStatus: () => true,
        responseType: "arraybuffer"
      });
      if (r.status === 200 && r.data.length > 30 && r.data.length < 500) {
        const dec = DownloadData.toObject(DownloadData.decode(new Uint8Array(r.data)));
        if (dec.url && dec.url.startsWith("U2FsdGVk")) {
          encUrl = dec.url;
          break;
        }
      }
    } catch (_) {}
  }
  if (!encUrl) throw new Error("CDN: POST flow did not return encrypted URL");

  // Step 5: Run the page script in a Node VM with an instrumented CryptoJS.
  //         The script registers onclick handlers on mocked DOM elements.
  //         When we call those handlers, they call fetch() (mocked to return the
  //         encrypted protobuf), decode the protobuf, then call
  //         CryptoJS.AES.decrypt(encUrl, secretKey) — which we intercept.
  //         The handler then calls window.open(decryptedUrl) — which we also capture.
  const pbBuf = Buffer.from(
    DownloadData.encode(DownloadData.create({ url: encUrl, error: "" })).finish()
  );

  let capturedUrl = null;
  let capturedKey = null;

  const instrCJS = {
    ...CryptoJS,
    AES: {
      ...CryptoJS.AES,
      decrypt: (enc, key) => {
        if (key !== "kasun" && !capturedKey) capturedKey = key;
        return CryptoJS.AES.decrypt(enc, key);
      }
    }
  };

  function mockEl() {
    return {
      style: {}, href: "", textContent: "", innerHTML: "",
      classList: { add: noop, remove: noop, contains: () => false },
      onclick: null,
      querySelector: () => mockEl(),
      querySelectorAll: () => []
    };
  }

  const btnHandlers = {};
  const vmCtx = vm.createContext({
    navigator: { userAgent: CDN_UA, maxTouchPoints: 5, webdriver: undefined, plugins: { length: 3 }, languages: ["en-US"], platform: "Android" },
    window: {
      location: { pathname: pUrl.pathname, search: pUrl.search, href: ztUrl, reload: noop },
      stop: noop, addEventListener: noop,
      open: (url) => { if (url && url.startsWith("http")) capturedUrl = url; }
    },
    document: {
      getElementById: (id) => { if (!btnHandlers[id]) btnHandlers[id] = mockEl(); return btnHandlers[id]; },
      querySelector: () => mockEl(),
      querySelectorAll: () => [],
      addEventListener: (e, fn) => { if (e === "DOMContentLoaded") { try { fn(); } catch (_) {} } },
      removeEventListener: noop,
      body: { classList: { add: noop }, innerText: "" },
      documentElement: { innerHTML: "", style: {} }
    },
    location: { pathname: pUrl.pathname, search: pUrl.search, href: ztUrl, reload: noop },
    fetch: async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => {
        const ab = new ArrayBuffer(pbBuf.length);
        new Uint8Array(ab).set(pbBuf);
        return ab;
      }
    }),
    DisableDevtool: noop, CryptoJS: instrCJS, protobuf,
    TextDecoder, TextEncoder,
    atob: s => Buffer.from(s, "base64").toString("binary"),
    btoa: s => Buffer.from(s, "binary").toString("base64"),
    Uint8Array, Uint8ClampedArray, Int8Array, Int16Array, Uint16Array,
    Int32Array, Uint32Array, ArrayBuffer, DataView,
    setTimeout: (fn, ms) => { try { if (typeof fn === "function") fn(); } catch (_) {} },
    clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    console: { log: noop, error: noop, warn: noop },
    checkPageValid: () => true, qjdnwymk: false,
    nfvdufpg: noop, alart: noop, showAlert: noop, hideAlert: noop,
    Promise, Error, JSON, Math, Date, Object, Array, String, Number, Boolean,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
    RegExp, Map, Set, Symbol, WeakMap
  });

  try { vm.runInContext(pageScript, vmCtx, { timeout: 8000 }); } catch (_) {}

  // Step 6: Fire every button onclick handler until we capture the URL
  const handlers = Object.entries(btnHandlers).filter(([, v]) => typeof v.onclick === "function");
  for (const [, btn] of handlers) {
    try { await btn.onclick(); } catch (_) {}
    if (capturedUrl) break;
  }

  // Step 7: If window.open gave us the URL directly, return it
  if (capturedUrl) return capturedUrl;

  // Fallback: decrypt manually if we captured the key but window.open wasn't called
  if (capturedKey) {
    const raw = cdnDecrypt(encUrl, capturedKey);
    if (raw) {
      const url = cdnB64toUtf8(raw);
      if (url.startsWith("http")) return url;
    }
  }

  throw new Error("CDN: could not extract download URL from page script");
}

// ─── Queue Engine ─────────────────────────────────────────────────────────────
async function executeCineDownload(task) {
  const { sock, from, mek, sender, directUrl, selectedLink, movie, caption, fileName } = task;
  const tempPath = path.join("/tmp", `cine_${Date.now()}.mp4`);
  const movieTitle = movie.metadata.title || "Movie";

  const progress = await sendLiveProgress(sock, from, mek, {
    title: movieTitle,
    quality: selectedLink.quality,
    size: selectedLink.size,
    downloadPercent: 0, uploadPercent: 0,
    stage: "Starting download...",
    downloadedBytes: 0, totalBytes: 0, speedBytesPerSecond: 0
  });

  let uploadTimer = null;
  global.activeCineDownloads.add(sender);

  try {
    progress.update({ stage: "Downloading film..." });
    const { downloadedBytes, totalBytes } = await downloadMovieToFile(directUrl, tempPath, update => {
      progress.update({ ...update, stage: "Downloading film..." });
    });

    const savedSize = fs.statSync(tempPath).size;
    progress.update({ downloadPercent: 100, uploadPercent: 0, downloadedBytes, totalBytes, stage: "Done! Sending to chat..." });

    if (savedSize > MOVIE_UPLOAD_MAX_BYTES) {
      const partCount = Math.min(3, Math.ceil(savedSize / MOVIE_UPLOAD_MAX_BYTES));
      progress.update({ downloadPercent: 100, uploadPercent: 0, stage: `Splitting into ${partCount} parts...` });

      let splitPercent = 0;
      const splitTimer = setInterval(() => {
        splitPercent = Math.min(30, splitPercent + 1);
        progress.update({ uploadPercent: splitPercent, stage: `Splitting into ${partCount} parts...` });
      }, 600);

      let partPaths = [];
      let usedFfmpeg = false;
      try {
        partPaths = await splitVideoWithFfmpeg(tempPath, partCount, movieTitle);
        usedFfmpeg = true;
      } catch (ffmpegErr) {
        console.error("ffmpeg split failed, falling back to byte-split:", ffmpegErr.message);
      }
      clearInterval(splitTimer);

      if (usedFfmpeg && partPaths.length) {
        await sock.sendMessage(from, {
          text:
            `╭─────────────────────────╮\n` +
            `│  🎬 *${movieTitle}*\n` +
            `│  📦 Sending in *${partCount} parts*\n` +
            `│  📥 Tap each part to download\n` +
            `│  ▶️  Opens in your video player\n` +
            `╰─────────────────────────╯`
        }, { quoted: mek });

        for (let i = 0; i < partPaths.length; i++) {
          const partNum = i + 1;
          let uploadPercent = 0;
          uploadTimer = setInterval(() => {
            uploadPercent = Math.min(95, uploadPercent + 3);
            progress.update({ uploadPercent, stage: `Uploading part ${partNum}/${partCount}...` });
          }, 1000);

          await sock.sendMessage(from, {
            document: { url: partPaths[i] },
            mimetype: "video/mp4",
            fileName: `${movieTitle} - Part ${partNum} of ${partCount}.mp4`,
            caption: `${caption}\n\n📥 *Part ${partNum} of ${partCount}* — tap to download, then play`
          }, { quoted: mek });

          clearInterval(uploadTimer);
          uploadTimer = null;
          if (fs.existsSync(partPaths[i])) fs.unlinkSync(partPaths[i]);
        }
        await progress.stop({ downloadPercent: 100, uploadPercent: 100, stage: `All ${partCount} parts sent! 🍿` });
      } else {
        await sendSplitMovieParts(sock, from, mek, tempPath, fileName.replace(".mp4", ""), caption, savedSize, progress, MOVIE_UPLOAD_MAX_BYTES);
        await progress.stop({ downloadPercent: 100, uploadPercent: 100, stage: "All parts sent! 🍿" });
      }
    } else {
      let uploadPercent = 0;
      uploadTimer = setInterval(() => {
        uploadPercent = Math.min(95, uploadPercent + 2);
        progress.update({ uploadPercent, stage: "Uploading film to chat..." });
      }, 1000);

      await sock.sendMessage(from, {
        video: { url: tempPath },
        mimetype: "video/mp4",
        fileName,
        caption
      }, { quoted: mek });

      clearInterval(uploadTimer);
      uploadTimer = null;
      await progress.stop({ downloadPercent: 100, uploadPercent: 100, stage: "Sent! 🍿" });
    }

  } catch (error) {
    console.error("CineFilm Download Error:", error.message);
    if (uploadTimer) clearInterval(uploadTimer);
    await progress.stop({ stage: "Failed ❌" });
    await sock.sendMessage(from, {
      text: `❌ *Failed to send movie.*\nError: ${error.message}\nPlease try again or choose a different quality.`
    }, { quoted: mek });
  } finally {
    global.activeCineDownloads.delete(sender);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    processCineQueue();
  }
}

function processCineQueue() {
  while (global.cineDownloadQueue.length > 0 && global.activeCineDownloads.size < MAX_MOVIE_DOWNLOADS) {
    const next = global.cineDownloadQueue.shift();

    global.cineDownloadQueue.forEach((item, i) => {
      item.sock.sendMessage(item.from, {
        text:
          `╭─────────────────────────╮\n` +
          `│  🎬 *Queue Update*\n` +
          `│\n` +
          `│  📋 You are now *#${i + 1}* in queue\n` +
          `│  🎬 ${item.movie.metadata.title}\n` +
          `│  ⏳ Almost there...\n` +
          `╰─────────────────────────╯`
      }, { quoted: item.mek }).catch(() => {});
    });

    next.sock.sendMessage(next.from, {
      text:
        `╭─────────────────────────╮\n` +
        `│  ✅ *Your Turn!*\n` +
        `│\n` +
        `│  🎬 ${next.movie.metadata.title}\n` +
        `│  📊 ${next.selectedLink.quality}  •  ${next.selectedLink.size}\n` +
        `│\n` +
        `│  ⬇️ Starting your download now...\n` +
        `╰─────────────────────────╯`
    }, { quoted: next.mek }).catch(() => {});

    executeCineDownload(next);
  }
}

// ─── Step 1: Search / Browse new releases ────────────────────────────────────
cmd({
  pattern: "cinefilm",
  alias: ["cinefilms", "cf", "cinef"],
  react: "🎬",
  desc: "Search and download movies from CineSubz.net with Sinhala subtitles",
  category: "download",
  filename: __filename
}, async (ranuxPro, mek, m, { from, q, sender, reply }) => {
  if (global.pendingMenu) delete global.pendingMenu[sender];
  if (global.pendingVideo) delete global.pendingVideo[sender];
  if (global.pendingCineFilm[sender]) delete global.pendingCineFilm[sender];

  // No query → show latest new releases
  if (!q) {
    await reply(`🔎 Loading latest movies from CineSubz...`);
    try {
      const results = await getNewReleases();
      if (!results.length) return reply(
        `❌ Could not load new releases right now.\n` +
        `Try: *.cinefilm <movie title>*\n` +
        `Example: _.cinefilm avatar_`
      );

      global.pendingCineFilm[sender] = { step: 1, results, timestamp: Date.now() };

      const text =
        `╭─────────────────────────╮\n` +
        `│  🎬 *CineSubz — New Releases*\n` +
        `│\n` +
        `│  🌐 cinesubz.net\n` +
        `│  📋 Found *${results.length}* new movies\n` +
        `│\n` +
        `│  👇 Tap to select a movie\n` +
        `╰─────────────────────────╯`;

      await sendBtn(ranuxPro, from, {
        image: { url: LOGO_URL },
        title: "🎬 CineSubz New Releases",
        text,
        buttons: results.map((r, i) => btn(`cf_select_${i + 1}`, `🎬 ${r.title.slice(0, 60)}`))
      }, { quoted: mek });

    } catch (e) {
      console.error("CineFilm browse error:", e.message);
      reply(`❌ Failed to load movies: ${e.message}\n\nTry searching: *.cinefilm avatar*`);
    }
    return;
  }

  // Query → search
  await reply(`🔍 Searching CineSubz for *"${q}"*...`);
  try {
    const results = await searchCineSubz(q);
    if (!results.length) return reply(
      `❌ *No results found for "${q}"*\n\n` +
      `• Try a shorter title (e.g. "avatar" not "avatar 2009")\n` +
      `• Try *.cinefilm* (no text) to browse new releases`
    );

    global.pendingCineFilm[sender] = { step: 1, results, timestamp: Date.now() };

    const text =
      `╭─────────────────────────╮\n` +
      `│  🎬 *CineSubz Search*\n` +
      `│\n` +
      `│  🔍 "${q}"\n` +
      `│  Found *${results.length}* result(s)\n` +
      `│\n` +
      `│  👇 Tap a title to select\n` +
      `╰─────────────────────────╯`;

    await sendBtn(ranuxPro, from, {
      image: { url: LOGO_URL },
      title: "🎬 CineSubz Search Results",
      text,
      buttons: results.map((r, i) => btn(`cf_select_${i + 1}`, `🎬 ${r.title.slice(0, 60)}`))
    }, { quoted: mek });

  } catch (e) {
    console.error("CineFilm Search Error:", e.message);
    reply(`❌ Search failed. Please try again.\n_${e.message || ""}_`);
  }
});

// ─── Cancel ───────────────────────────────────────────────────────────────────
cmd({
  pattern: "cancelcf",
  alias: ["stopcf", "cfcancel"],
  react: "🚫",
  desc: "Cancel current CineFilm download session",
  category: "download",
  filename: __filename
}, async (ranuxPro, mek, m, { sender, reply }) => {
  if (global.pendingCineFilm[sender]) {
    delete global.pendingCineFilm[sender];
    reply("✅ *Cancelled.* Start again anytime with `.cinefilm <title>`");
  } else {
    reply("ℹ️ No active CineFilm session to cancel.");
  }
});

// ─── Step 2: Movie selected → show details + quality buttons ─────────────────
cmd({
  filter: (body, { sender }) =>
    global.pendingCineFilm[sender] &&
    global.pendingCineFilm[sender].step === 1 &&
    /^cf_select_\d+$/.test(body)
}, async (ranuxPro, mek, m, { body, sender, reply, from }) => {

  await ranuxPro.sendMessage(from, { react: { text: "⏳", key: mek.key } });

  const index = parseInt(body.replace("cf_select_", "")) - 1;
  const { results } = global.pendingCineFilm[sender];

  if (index < 0 || index >= results.length) {
    return reply("❌ Invalid selection. Please search again.");
  }

  const selected = results[index];
  delete global.pendingCineFilm[sender];

  try {
    await reply(`⏳ Loading *"${selected.title.slice(0, 60)}"*...`);
    const metadata = await getMovieMetadata(selected.movieUrl);

    const metaMsg =
      `╭─────────────────────────╮\n` +
      `│  🎬 *${metadata.title}*\n` +
      `│\n` +
      `│  ⭐ IMDb: ${metadata.imdb}\n` +
      `│  🕒 ${metadata.duration}${metadata.year ? "  •  " + metadata.year : ""}\n` +
      (metadata.genres.length ? `│  🎭 ${metadata.genres.slice(0, 4).join(", ")}\n` : "") +
      `│  🌐 ${metadata.language}\n` +
      (metadata.director ? `│  🎥 ${metadata.director.slice(0, 50)}\n` : "") +
      (metadata.country ? `│  📍 ${metadata.country.slice(0, 40)}\n` : "") +
      `│\n` +
      `│  ⏳ Loading download options...\n` +
      `╰─────────────────────────╯`;

    if (metadata.thumbnail) {
      await ranuxPro.sendMessage(from, { image: { url: metadata.thumbnail }, caption: metaMsg }, { quoted: mek });
    } else {
      await ranuxPro.sendMessage(from, { text: metaMsg }, { quoted: mek });
    }

    const downloadLinks = await getDownloadLinks(selected.movieUrl);
    if (!downloadLinks.length) {
      return reply(
        `❌ *No download links found for this movie.*\n\n` +
        `The site may not have upload links yet. Try another movie.`
      );
    }

    global.pendingCineFilm[sender] = {
      step: 2,
      movie: { metadata, downloadLinks },
      timestamp: Date.now()
    };

    const qualityText =
      `╭─────────────────────────╮\n` +
      `│  📥 *Choose Quality*\n` +
      `│\n` +
      `│  🎬 ${metadata.title}\n` +
      `│  ${downloadLinks.length} option(s) — best quality first\n` +
      `│\n` +
      `│  👇 Tap to start download\n` +
      `╰─────────────────────────╯`;

    await sendBtn(ranuxPro, from, {
      text: qualityText,
      buttons: downloadLinks.map((d, i) => btn(`cf_dl_${i + 1}`, `📥 ${d.quality}  •  ${d.size}  •  ${d.lang || ""}`))
    }, { quoted: mek });

  } catch (e) {
    delete global.pendingCineFilm[sender];
    console.error("CineFilm Detail Error:", e.message);
    reply(`❌ Couldn't load this movie. Please try again.\n_${e.message || ""}_`);
  }
});

// ─── Step 3: Quality selected → resolve link + download ──────────────────────
cmd({
  filter: (body, { sender }) =>
    global.pendingCineFilm[sender] &&
    global.pendingCineFilm[sender].step === 2 &&
    /^cf_dl_\d+$/.test(body)
}, async (ranuxPro, mek, m, { body, sender, reply, from }) => {

  const index = parseInt(body.replace("cf_dl_", "")) - 1;
  const { movie } = global.pendingCineFilm[sender];

  if (index < 0 || index >= movie.downloadLinks.length) {
    return reply("❌ Invalid quality selection. Please try again.");
  }

  const selectedLink = movie.downloadLinks[index];
  delete global.pendingCineFilm[sender];

  await ranuxPro.sendMessage(from, { react: { text: "🔗", key: mek.key } });
  await reply(`🔗 Resolving download link for *${selectedLink.quality}*...`);

  let directUrl;
  try {
    directUrl = await resolveZtLink(selectedLink.ztLink);
  } catch (e) {
    return reply(`❌ Could not resolve download link.\n_${e.message}_\n\nPlease try a different quality.`);
  }

  if (!directUrl) {
    return reply("❌ Download link not available. Please try a different quality.");
  }

  const caption =
    `╭─────────────────────────╮\n` +
    `│  ✅ *Movie Ready!*\n` +
    `│\n` +
    `│  🎬 ${movie.metadata.title}\n` +
    `│  📊 ${selectedLink.quality}  •  ${selectedLink.size}\n` +
    (selectedLink.lang ? `│  🌐 ${selectedLink.lang}\n` : "") +
    `│\n` +
    `│  🍿 Enjoy watching!\n` +
    `╰─────────────────────────╯`;

  const fileName = `${movie.metadata.title.slice(0, 50)} - ${selectedLink.quality}.mp4`
    .replace(/[^\w\s.-]/gi, "");

  const task = { sock: ranuxPro, from, mek, sender, directUrl, selectedLink, movie, caption, fileName };

  if (global.activeCineDownloads.size < MAX_MOVIE_DOWNLOADS) {
    executeCineDownload(task);
    return;
  }

  global.cineDownloadQueue.push(task);
  const queuePos = global.cineDownloadQueue.length;
  await reply(
    `╭─────────────────────────╮\n` +
    `│  📋 *Added to Queue*\n` +
    `│\n` +
    `│  🎬 ${movie.metadata.title}\n` +
    `│  📊 ${selectedLink.quality}  •  ${selectedLink.size}\n` +
    `│\n` +
    `│  🔢 Queue position: *#${queuePos}*\n` +
    `│  ⚙️ Active: ${global.activeCineDownloads.size}/${MAX_MOVIE_DOWNLOADS}\n` +
    `│\n` +
    `│  ⏳ You'll be notified when it's your turn.\n` +
    `╰─────────────────────────╯`
  );
});

// ─── Stale session cleanup ────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  for (const sender in global.pendingCineFilm) {
    if (now - (global.pendingCineFilm[sender].timestamp || 0) > timeout) {
      delete global.pendingCineFilm[sender];
    }
  }
}, 5 * 60 * 1000);
