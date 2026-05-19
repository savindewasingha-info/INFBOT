const { cmd } = require("../../command");
const axios = require("axios");
const cheerio = require("cheerio");
const { sendBtn, btn, urlBtn, navButtons } = require("../../utils/sendBtn");

global.pendingCine = global.pendingCine || {};

const BASE_URL = "https://cinesubz.net";
const LOGO_URL = "https://files.catbox.moe/2jt3ln.png";

const PROXY_POOL = [
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];
const proxyCooldown = new Array(PROXY_POOL.length).fill(0);
const PROXY_COOLDOWN_MS = 90 * 1000;

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function cineFetch(url, retries = 3) {
  let lastError;
  let realAttempts = 0;
  let proxySkips = 0;
  const now = () => Date.now();

  while (realAttempts < retries) {
    let proxyIndex = proxyCooldown.findIndex(until => now() >= until);
    if (proxyIndex === -1) {
      proxyIndex = proxyCooldown.indexOf(Math.min(...proxyCooldown));
      const wait = Math.max(0, proxyCooldown[proxyIndex] - now());
      await new Promise(r => setTimeout(r, wait));
    }

    try {
      const res = await axios.get(PROXY_POOL[proxyIndex](url), {
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.8"
        },
        validateStatus: s => true
      });

      if (res.status === 429 || res.status === 403) {
        proxyCooldown[proxyIndex] = now() + PROXY_COOLDOWN_MS;
        lastError = new Error(`Proxy blocked (${res.status}) — try again shortly.`);
        proxySkips++;
        if (proxySkips > PROXY_POOL.length) { realAttempts++; proxySkips = 0; }
        continue;
      }
      if (res.status >= 400) throw new Error(`HTTP ${res.status} from site`);

      return res.data;
    } catch (err) {
      lastError = err;
      realAttempts++;
      if (realAttempts < retries) await new Promise(r => setTimeout(r, 2000 * realAttempts));
    }
  }
  throw lastError;
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────
async function searchMovies(query) {
  const html = await cineFetch(`${BASE_URL}/?s=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);
  const results = [];

  const SKIP = /\/(page|category|release|genre)\//;
  const VALID = /\/(movies|tvshows)\//;

  const tryAdd = (href, title) => {
    href = (href || '').trim();
    title = (title || '').trim();
    if (!href || !title || !VALID.test(href) || SKIP.test(href)) return;
    if (href === `${BASE_URL}/movies/` || href === `${BASE_URL}/tvshows/`) return;
    if (results.find(r => r.movieUrl === href)) return;
    if (results.length >= 8) return;
    results.push({ id: results.length + 1, title, movieUrl: href });
  };

  // Primary selectors
  $('.ml-item a[href], .item a[href]').each((_, el) => {
    tryAdd($(el).attr('href'), $(el).attr('title') || $(el).text());
  });

  // Fallback — scan all links
  if (!results.length) {
    $('a[href]').each((_, el) => {
      tryAdd($(el).attr('href'), $(el).attr('title') || $(el).text());
    });
  }

  return results;
}

async function getMovieDetails(movieUrl) {
  const html = await cineFetch(movieUrl);
  const $ = cheerio.load(html);

  let title = $('h1').first().text().trim();
  if (!title || title.includes('Download Links')) {
    title = $('title').text().split(/[–|-]/)[0].trim() || 'Unknown Title';
  }

  const lines = $.root().text().split('\n').map(l => l.trim()).filter(Boolean);
  let imdb = 'N/A', director = 'N/A', year = 'N/A', country = 'N/A', subtitleBy = 'N/A';

  for (const line of lines) {
    if (line.includes('IMDb:'))           imdb       = line.split('IMDb:')[1]?.trim()        || 'N/A';
    else if (line.includes('Director:'))  director   = line.split('Director:')[1]?.trim()    || 'N/A';
    else if (line.includes('Year:'))      year       = line.split('Year:')[1]?.trim()        || 'N/A';
    else if (line.includes('Country:'))   country    = line.split('Country:')[1]?.trim()     || 'N/A';
    else if (line.includes('Subtitle By:')) subtitleBy = line.split('Subtitle By:')[1]?.trim() || 'N/A';
  }

  let description = $('.description, #edit-content').first().text().trim();
  if (!description) {
    let foundMeta = false;
    const parts = [];
    for (const line of lines) {
      if (/Country:|Cast/i.test(line)) { foundMeta = true; continue; }
      if (foundMeta && line.length > 50 && !/Direct|Telegram|Download|Comment/i.test(line)) parts.push(line);
      if (foundMeta && /Share/i.test(line)) break;
    }
    description = parts.join(' ');
  }

  // Download links (zt-links anchor tags)
  const downloadLinks = [];
  $('a[href*="zt-links"]').each((_, el) => {
    const label = $(el).text().replace('Direct & Telegram Download Links', '').trim() || 'Download';
    const href = $(el).attr('href');
    if (href) downloadLinks.push({ label, link: href });
  });

  const thumbnail =
    $('img.thumb').attr('src') ||
    $('.movie-thumbnail img, .poster img').first().attr('src') ||
    $('img[src*="wp-content/uploads"]').first().attr('src') ||
    '';

  return { title, imdb, director, year, country, subtitleBy, description, downloadLinks, thumbnail };
}

// ─── Step 1: Search ───────────────────────────────────────────────────────────
cmd({
  pattern: "film2",
  alias: ["cine", "cinesubz"],
  react: "🎬",
  desc: "Search and get download links from CineSubz.net",
  category: "download",
  filename: __filename
}, async (sock, mek, m, { from, q, sender, reply }) => {
  if (!q) return reply(
    `🎬 *CineSubz Movie Downloader*\n\n` +
    `Usage: \`.film2 <title>\`\n` +
    `Example: \`.film2 avatar\`\n\n` +
    `_Also works with:_ \`.cine\` | \`.cinesubz\``
  );

  if (global.pendingCine[sender]) delete global.pendingCine[sender];
  await reply(`🔍 Searching for *"${q}"* on CineSubz...`);

  try {
    const results = await searchMovies(q);
    if (!results.length) return reply(
      `❌ *No results found for "${q}"*\n\nTry a shorter or different title.`
    );

    global.pendingCine[sender] = { step: 1, results, timestamp: Date.now() };

    const text =
      `╭─────────────────────────╮\n` +
      `│  🎬 *CineSubz Search*\n` +
      `│\n` +
      `│  🔍 "${q}"\n` +
      `│  Found *${results.length}* result(s)\n` +
      `│\n` +
      `│  👇 Tap a title to select\n` +
      `╰─────────────────────────╯`;

    const movieButtons = results.map((r, i) =>
      btn(`cine_select_${i + 1}`, `🎬 ${r.title}`)
    );

    await sendBtn(sock, from, {
      image: { url: LOGO_URL },
      title: "🎬 CineSubz Results",
      text,
      buttons: movieButtons,
    }, { quoted: mek });

  } catch (e) {
    console.error('CineSubz search error:', e.message);
    reply(`❌ *Search failed.* Please try again.\n_${e.message}_`);
  }
});

// ─── Cancel cine session ──────────────────────────────────────────────────────
cmd({
  pattern: "cancelcine",
  alias: ["cinestop", "cinecancel"],
  react: "🚫",
  desc: "Cancel your current CineSubz session",
  category: "download",
  filename: __filename
}, async (sock, mek, m, { from, sender, reply }) => {
  if (global.pendingCine[sender]) {
    delete global.pendingCine[sender];
    reply("✅ *Cancelled.* Start a new search anytime with `.film2 <title>`");
  } else {
    reply("ℹ️ No active CineSubz session to cancel.");
  }
});

// ─── Step 2: Movie Details (button tap cine_select_N) ────────────────────────
cmd({
  filter: (body, { sender }) =>
    global.pendingCine[sender] &&
    global.pendingCine[sender].step === 1 &&
    /^cine_select_\d+$/.test(body)
}, async (sock, mek, m, { body, sender, reply, from }) => {

  await sock.sendMessage(from, { react: { text: '⏳', key: mek.key } });

  const index = parseInt(body.replace('cine_select_', '')) - 1;
  const { results } = global.pendingCine[sender];

  if (index < 0 || index >= results.length) {
    return reply('❌ *Invalid selection. Please search again.*');
  }

  const selected = results[index];
  delete global.pendingCine[sender];

  try {
    await reply(`⏳ Loading *"${selected.title}"*...`);
    const details = await getMovieDetails(selected.movieUrl);
    const movieTitle = details.title || selected.title;

    const infoMsg =
      `╭─────────────────────────╮\n` +
      `│  🎬 *${movieTitle}*\n` +
      `│\n` +
      `│  ⭐ IMDb:     ${details.imdb}\n` +
      `│  📅 Year:     ${details.year}\n` +
      `│  🌍 Country:  ${details.country}\n` +
      `│  🎬 Director: ${details.director}\n` +
      `│  🔤 Subtitle: ${details.subtitleBy}\n` +
      (details.description
        ? `│\n│  📝 ${details.description.slice(0, 150).trim()}...\n`
        : '') +
      `│\n` +
      `│  ⏳ Loading download links...\n` +
      `╰─────────────────────────╯`;

    if (details.thumbnail) {
      await sock.sendMessage(from, { image: { url: details.thumbnail }, caption: infoMsg }, { quoted: mek });
    } else {
      await sock.sendMessage(from, { text: infoMsg }, { quoted: mek });
    }

    if (!details.downloadLinks.length) {
      return reply('❌ *No download links found for this title.*\n\nTry a different movie or check back later.');
    }

    const dlText =
      `╭─────────────────────────╮\n` +
      `│  📥 *Download Links*\n` +
      `│  🎬 ${movieTitle}\n` +
      `│\n` +
      `│  👇 Tap a link to open\n` +
      `╰─────────────────────────╯`;

    // Use URL buttons so tapping opens the download page directly
    const dlButtons = details.downloadLinks.slice(0, 5).map(dl =>
      urlBtn(`📥 ${dl.label || 'Download'}`, dl.link)
    );

    // Always add nav buttons at end
    await sendBtn(sock, from, {
      text: dlText,
      title: `📥 ${movieTitle}`,
      buttons: [...dlButtons, ...navButtons],
    }, { quoted: mek });

  } catch (e) {
    delete global.pendingCine[sender];
    console.error('CineSubz detail error:', e.message);
    reply(`❌ *Failed to load this title.* Please try again.\n_${e.message}_`);
  }
});

// ─── Auto-cleanup stale sessions ──────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000;
  for (const sender in global.pendingCine) {
    if (now - (global.pendingCine[sender].timestamp || 0) > timeout) {
      delete global.pendingCine[sender];
    }
  }
}, 5 * 60 * 1000);
