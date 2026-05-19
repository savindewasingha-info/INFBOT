const { cmd } = require("../command");
const puppeteer = require("puppeteer");
const config = require("../config");

// Global State
global.pendingMovie = global.pendingMovie || {};

// Design Elements
const LOGO_URL = "https://files.catbox.moe/2jt3ln.png"; // Sinhalasub Logo
const FOOTER = "> 👑 ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴋɪɴɢ ʀᴀɴᴜx ᴘʀᴏ";

// ===============================================================
// CORE SCRAPING LOGIC (UNCHANGED)
// ===============================================================

function normalizeQuality(text) {
  if (!text) return null;
  text = text.toUpperCase();
  if (/1080|FHD/.test(text)) return "1080p";
  if (/720|HD/.test(text)) return "720p";
  if (/480|SD/.test(text)) return "480p";
  return text;
}

function getDirectPixeldrainUrl(url) {
  const match = url.match(/pixeldrain\.com\/u\/(\w+)/);
  if (!match) return null;
  return `https://pixeldrain.com/api/file/${match[1]}?download`;
}

async function searchMovies(query) {
  const searchUrl = `https://sinhalasub.lk/?s=${encodeURIComponent(query)}&post_type=movies`;
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 45000 });
  const results = await page.$$eval(".display-item .item-box", boxes =>
    boxes.slice(0, 10).map((box, index) => {
      const a = box.querySelector("a");
      return {
        id: index + 1,
        title: a?.title?.trim() || "Unknown Title",
        movieUrl: a?.href || "",
      };
    }).filter(m => m.title && m.movieUrl)
  );
  await browser.close();
  return results;
}

async function getMovieMetadata(url) {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });
  const metadata = await page.evaluate(() => {
    const getText = el => el?.textContent.trim() || "";
    const getList = selector => Array.from(document.querySelectorAll(selector)).map(el => el.textContent.trim());
    const title = getText(document.querySelector(".info-details .details-title h3"));
    let language = "N/A", directors = [];
    document.querySelectorAll(".info-col p").forEach(p => {
      const strong = p.querySelector("strong");
      if (!strong) return;
      const txt = strong.textContent.trim();
      if (txt.includes("Language:")) language = strong.nextSibling?.textContent?.trim() || "N/A";
      if (txt.includes("Director:")) directors = Array.from(p.querySelectorAll("a")).map(a => a.textContent.trim());
    });
    const duration = getText(document.querySelector(".info-details .data-views[itemprop='duration']")) || "N/A";
    const imdb = getText(document.querySelector(".info-details .data-imdb"))?.replace("IMDb:", "").trim() || "N/A";
    const genres = getList(".details-genre a");
    const thumbnail = document.querySelector(".splash-bg img")?.src || "";
    return { title, language, duration, imdb, genres, directors, thumbnail };
  });
  await browser.close();
  return metadata;
}

async function getPixeldrainLinks(movieUrl) {
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.goto(movieUrl, { waitUntil: "networkidle2", timeout: 60000 });
  const linksData = await page.$$eval(".link-pixeldrain tbody tr", rows =>
    rows.map(row => {
      const a = row.querySelector(".link-opt a");
      const quality = row.querySelector(".quality")?.textContent.trim() || "";
      const size = row.querySelector("td:nth-child(3) span")?.textContent.trim() || "";
      return { pageLink: a?.href || "", quality, size };
    })
  );
  const directLinks = [];
  for (const l of linksData) {
    try {
      const subPage = await browser.newPage();
      await subPage.goto(l.pageLink, { waitUntil: "networkidle2", timeout: 45000 });
      await new Promise(r => setTimeout(r, 12000));
      const finalUrl = await subPage.$eval(".wait-done a[href^='https://pixeldrain.com/']", el => el.href).catch(() => null);
      if (finalUrl) {
        let sizeMB = 0;
        const sizeText = l.size.toUpperCase();
        if (sizeText.includes("GB")) sizeMB = parseFloat(sizeText) * 1024;
        else if (sizeText.includes("MB")) sizeMB = parseFloat(sizeText);
        if (sizeMB > 0 && sizeMB <= 2048) {
          directLinks.push({ link: finalUrl, quality: normalizeQuality(l.quality), size: l.size });
        }
      }
      await subPage.close();
    } catch (e) { continue; }
  }
  await browser.close();
  return directLinks;
}

// ===============================================================
// COMMANDS (WITH CUTE & PREMIUM UI)
// ===============================================================

// Step 1: Initial Search
cmd({
  pattern: "movie",
  alias: ["sinhalasub", "films", "mv"],
  react: "🎬",
  desc: "Search and Download movies from Sinhalasub.lk",
  category: "download",
  filename: __filename
}, async (ranuxPro, mek, m, { from, q, sender, reply }) => {
  if (!q) return reply(`*ℹ️ Please provide a movie name.*\n\n*Example:* \`.movie avatar\``);

  // Clear other states
  if (global.pendingMenu) delete global.pendingMenu[sender];
  if (global.pendingVideo) delete global.pendingVideo[sender];

  await reply(`*⏳ Searching for "${q}"...*`);

  try {
    const searchResults = await searchMovies(q);
    if (!searchResults.length) return reply("*❌ No movies found matching your query!*");

    global.pendingMovie[sender] = { step: 1, results: searchResults };

    // ✨ CUTE & PREMIUM SEARCH UI
    let text = `╭───〔 🎬 *𝐌𝐎𝐕𝐈𝐄 𝐒𝐄𝐀𝐑𝐂𝐇* 〕───┈
│ 
│ 🔍 *🎬 Search Results For:* "${q}"
│ 🌸 *Found:* ${searchResults.length} Movies
│ 
╰──────────────────────┈

╭───〔 📂 *𝐑𝐄𝐒𝐔𝐋𝐓𝐒* 〕───┈
│
`;

    searchResults.forEach((movie, i) => {
        text += `│ *${i + 1}* ➻ ${movie.title}\n`;
    });

    text += `│
╰──────────────────────┈
│ 🔢 *Reply with a number to select!*
╰──────────────────────┈
${FOOTER}`;

    // Send with Logo
    await ranuxPro.sendMessage(from, { 
        image: { url: LOGO_URL },
        caption: text.trim() 
    }, { quoted: mek });

  } catch (e) {
    console.error("Movie Search Error:", e);
    reply("❌ *An error occurred during the search. Please try again later.*");
  }
});

// Step 2: Movie Details (Logic Fixed)
cmd({
  filter: (text, { sender }) => 
    global.pendingMovie[sender] &&
    global.pendingMovie[sender].step === 1 && 
    /^\d+$/.test(text.trim())
}, async (ranuxPro, mek, m, { body, sender, reply, from }) => {

  await ranuxPro.sendMessage(from, { react: { text: "⏳", key: mek.key } });

  const index = parseInt(body.trim()) - 1;
  const { results } = global.pendingMovie[sender];

  if (index < 0 || index >= results.length) {
    return reply("❌ *Invalid number. Please select from the list.*");
  }

  const selected = results[index];

  try {
    await reply(`*⏳ Fetching details for "${selected.title}"...*`);
    const metadata = await getMovieMetadata(selected.movieUrl);

    let metaMsg = `
╭───〔 🎬 *𝐌𝐎𝐕𝐈𝐄 𝐃𝐄𝐓𝐀𝐈𝐋𝐒* 〕───┈
│
│ 🏷️ *Title:* ${metadata.title}
│ ⭐ *IMDb:* ${metadata.imdb}
│ 🕒 *Duration:* ${metadata.duration}
│ 🎭 *Genre:* ${metadata.genres.join(", ")}
│ 👤 *Director:* ${metadata.directors.join(", ")}
│
╰──────────────────────┈

📥 *Fetching download links...*
( ｡ • ̀ ω • ́ ｡ ) Please wait...`;

    if (metadata.thumbnail) {
      await ranuxPro.sendMessage(from, { image: { url: metadata.thumbnail }, caption: metaMsg.trim() }, { quoted: mek });
    } else {
      await ranuxPro.sendMessage(from, { text: metaMsg.trim() }, { quoted: mek });
    }

    const downloadLinks = await getPixeldrainLinks(selected.movieUrl);
    if (!downloadLinks.length) {
        delete global.pendingMovie[sender]; 
        return reply(`*❌ No direct download links found under 2GB!*`);
    }

    // ✅ STRONG LOGIC FIX:
    global.pendingMovie[sender] = { 
        step: 2, 
        movie: { metadata, downloadLinks },
        lastMsgId: mek.key.id 
    };

    let qualityMsg = `
╭───〔 📥 *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃 𝐋𝐈𝐒𝐓* 〕───┈
│
`;
    downloadLinks.forEach((d, i) => {
        qualityMsg += `│ *${i + 1}* ➻ ${d.quality}  [${d.size}]\n`;
    });
    qualityMsg += `│
╰──────────────────────┈
│ 🔢 *Reply with a number to download!*
╰──────────────────────┈`;

    await ranuxPro.sendMessage(from, { text: qualityMsg.trim() }, { quoted: mek });
  } catch (e) {
    delete global.pendingMovie[sender]; 
    console.error("Movie Detail Fetch Error:", e);
    reply("❌ *Failed to fetch movie details. The website might be down.*");
  }
});

// Step 3: Download (Logic Fixed)
cmd({
  filter: (text, { sender, message }) => 
    global.pendingMovie[sender] &&
    global.pendingMovie[sender].step === 2 && 
    // ✅ CHECK: Ensure we are replying to a NEW message
    message.key.id !== global.pendingMovie[sender].lastMsgId &&
    /^\d+$/.test(text.trim())
}, async (ranuxPro, mek, m, { body, sender, reply, from }) => {

  const index = parseInt(body.trim()) - 1;
  const { movie } = global.pendingMovie[sender];

  if (index < 0 || index >= movie.downloadLinks.length) {
    return reply("❌ *Invalid quality selection.*");
  }

  const selectedLink = movie.downloadLinks[index];
  delete global.pendingMovie[sender]; // Clear state immediately

  await reply(`*🚀 Download initiated for "${movie.metadata.title}" (${selectedLink.quality}). Please wait...*`);

  try {
    const directUrl = getDirectPixeldrainUrl(selectedLink.link);
    if (!directUrl) throw new Error("Could not generate direct download link.");

    const fileName = `${movie.metadata.title.substring(0, 50)} - ${selectedLink.quality}.mp4`.replace(/[^\w\s.-]/gi, '');
    const caption = `
╭───〔 ✅ *𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐄𝐃* 〕───┈
│
│ 🎬 *Movie:* ${movie.metadata.title}
│ 📊 *Quality:* ${selectedLink.quality}
│ 💾 *Size:* ${selectedLink.size}
│
╰──────────────────────┈
🍿 *Enjoy the movie!*

> ${config.MOVIE_FOOTER_TEXT || "> 👑 ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴋɪɴɢ ʀᴀɴᴜx ᴘʀᴏ"}`;

    await ranuxPro.sendMessage(from, {
      document: { url: directUrl },
      mimetype: "video/mp4",
      fileName: fileName,
      caption: caption.trim()
    }, { quoted: mek });
  } catch (error) {
    console.error("Send document error:", error);
    reply(`*❌ Failed to send movie:* ${error.message || "An unknown error occurred."}`);
  }
});

// Auto-cleanup
setInterval(() => {
  const now = Date.now();
  const timeout = 10 * 60 * 1000; 
  for (const sender in global.pendingMovie) {
    if (now - (global.pendingMovie[sender].timestamp || 0) > timeout) {
      delete global.pendingMovie[sender];
    }
  }
}, 5 * 60 * 1000);
