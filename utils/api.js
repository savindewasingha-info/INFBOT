/**
 * API Integration Utilities
 */

const axios = require('axios');

const api = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  }
});

// API Endpoints
const APIs = {
  // Image Generation
  generateImage: async (prompt) => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/ai/stablediffusion`, {
        params: { prompt }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to generate image');
    }
  },
  
  // AI Chat - Shizo API
  chatAI: async (text) => {
    try {
      const response = await api.get(`https://api.shizo.top/ai/gpt?apikey=shizo&query=${encodeURIComponent(text)}`);
      if (response.data && response.data.msg) {
        return { msg: response.data.msg };
      }
      return response.data;
    } catch (error) {
      throw new Error('Failed to get AI response');
    }
  },
  
  // YouTube Download
  ytDownload: async (url, type = 'audio') => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/d/ytmp3`, {
        params: { url }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to download YouTube video');
    }
  },
  
  // Instagram Download
  igDownload: async (url) => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/d/igdl`, {
        params: { url }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to download Instagram content');
    }
  },
  
  // TikTok Download
  tiktokDownload: async (url) => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/d/tiktok`, {
        params: { url }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to download TikTok video');
    }
  },
  
  // Translate
  translate: async (text, to = 'en') => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/tools/translate`, {
        params: { text, to }
      });
      return response.data;
    } catch (error) {
      throw new Error('Translation failed');
    }
  },
  
  // Random Meme
  getMeme: async () => {
    try {
      const response = await api.get('https://meme-api.com/gimme');
      return response.data;
    } catch (error) {
      throw new Error('Failed to fetch meme');
    }
  },
  
  // Random Quote
  getQuote: async () => {
    try {
      const response = await api.get('https://api.quotable.io/random');
      return response.data;
    } catch (error) {
      throw new Error('Failed to fetch quote');
    }
  },
  
  // Random Joke
  getJoke: async () => {
    try {
      const response = await api.get('https://official-joke-api.appspot.com/random_joke');
      return response.data;
    } catch (error) {
      throw new Error('Failed to fetch joke');
    }
  },
  
  // Weather
  getWeather: async (city) => {
    try {
      const response = await api.get(`https://api.siputzx.my.id/api/tools/weather`, {
        params: { city }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to fetch weather');
    }
  },
  
  // Shorten URL
  shortenUrl: async (url) => {
    try {
      const response = await api.get(`https://tinyurl.com/api-create.php`, {
        params: { url }
      });
      return response.data;
    } catch (error) {
      throw new Error('Failed to shorten URL');
    }
  },
  
  // Wikipedia Search
  wikiSearch: async (query) => {
    try {
      const response = await api.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
      return response.data;
    } catch (error) {
      throw new Error('Wikipedia search failed');
    }
  },
  
  // Song Download APIs
  getIzumiDownloadByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://izumiiiiiiii.dpdns.org/downloader/youtube?url=${encodeURIComponent(youtubeUrl)}&format=mp3`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.result?.download) return res.data.result;
    throw new Error('Izumi youtube?url returned no download');
  },

  getIzumiDownloadByQuery: async (query) => {
    const res = await axios.get(
      `https://izumiiiiiiii.dpdns.org/downloader/youtube-play?query=${encodeURIComponent(query)}`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.result?.download) return res.data.result;
    throw new Error('Izumi youtube-play returned no download');
  },

  getYupraDownloadByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://api.yupra.my.id/api/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.success && res?.data?.data?.download_url)
      return { download: res.data.data.download_url, title: res.data.data.title, thumbnail: res.data.data.thumbnail };
    throw new Error('Yupra returned no download');
  },

  getOkatsuDownloadByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp3?url=${encodeURIComponent(youtubeUrl)}`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.dl)
      return { download: res.data.dl, title: res.data.title, thumbnail: res.data.thumb };
    throw new Error('Okatsu ytmp3 returned no download');
  },

  getEliteProTechDownloadByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp3`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.success && res?.data?.downloadURL)
      return { download: res.data.downloadURL, title: res.data.title };
    throw new Error('EliteProTech ytdown returned no download');
  },

  getEliteProTechVideoByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://eliteprotech-apis.zone.id/ytdown?url=${encodeURIComponent(youtubeUrl)}&format=mp4`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.success && res?.data?.downloadURL)
      return { download: res.data.downloadURL, title: res.data.title };
    throw new Error('EliteProTech ytdown video returned no download');
  },

  // Video Download APIs
  getYupraVideoByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://api.yupra.my.id/api/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.success && res?.data?.data?.download_url)
      return { download: res.data.data.download_url, title: res.data.data.title, thumbnail: res.data.data.thumbnail };
    throw new Error('Yupra returned no download');
  },

  getOkatsuVideoByUrl: async (youtubeUrl) => {
    const res = await axios.get(
      `https://okatsu-rolezapiiz.vercel.app/downloader/ytmp4?url=${encodeURIComponent(youtubeUrl)}`,
      { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*' } }
    );
    if (res?.data?.result?.mp4)
      return { download: res.data.result.mp4, title: res.data.result.title };
    throw new Error('Okatsu ytmp4 returned no mp4');
  },
  
  // TikTok Download API
  getTikTokDownload: async (url) => {
    // If it's a search query instead of a link, use the search endpoint
    if (!url.includes('tiktok.com') && !url.includes('vt.tiktok')) {
      return APIs.tiktokSearch(url);
    }

    // Try multiple APIs for TikTok download
    const apiUrls = [
      `https://api.siputzx.my.id/api/d/tiktok?url=${encodeURIComponent(url)}`,
      `https://api.shizokeu.xyz/api/download/tiktok?url=${encodeURIComponent(url)}`,
      `https://api.vreden.my.id/api/tiktok?url=${encodeURIComponent(url)}`
    ];
    
    for (const apiUrl of apiUrls) {
      try {
        const response = await axios.get(apiUrl, { 
          timeout: 15000,
          headers: {
            'accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        if (response.data && response.data.status && response.data.data) {
          let videoUrl = null;
          let title = null;
          const d = response.data.data;
          
          videoUrl = d.urls?.[0] || d.video_url || d.url || d.download_url || d.nowm || d.no_watermark;
          title = d.metadata?.title || d.title || 'TikTok Video';
          
          if (videoUrl) return { videoUrl, title };
        }
      } catch (error) {
        continue;
      }
    }
    throw new Error('TikTok download failed on all mirrors');
  },

  // TikTok Search API
  tiktokSearch: async (query) => {
    const apiKey = 'dew_FEIXBd8x3XE6eshtBtM1NwEV5IxSLI6PeRE2zLmi';
    const apiUrl = `https://api.srihub.store/search/tiktok?q=${encodeURIComponent(query)}&apikey=${apiKey}`;
    
    try {
      const response = await axios.get(apiUrl, { 
        timeout: 25000,
        headers: {
          'accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.data && response.data.success && Array.isArray(response.data.result)) {
        return response.data.result;
      }
      
      throw new Error('Invalid response from search API');
    } catch (error) {
      throw error;
    }
  },
  
  // Screenshot Website API
  screenshotWebsite: async (url) => {
    try {
      const apiUrl = `https://eliteprotech-apis.zone.id/ssweb?url=${encodeURIComponent(url)}`;
      const response = await axios.get(apiUrl, {
        timeout: 30000,
        responseType: 'arraybuffer',
        headers: {
          'accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      // Return the image buffer directly (API returns PNG binary)
      if (response.headers['content-type']?.includes('image')) {
        return Buffer.from(response.data);
      }
      
      // If API returns JSON with URL, try to parse it
      try {
        const data = JSON.parse(Buffer.from(response.data).toString());
        return data.url || data.data?.url || data.image || apiUrl;
      } catch (e) {
        // If not JSON, assume it's image data and return buffer
        return Buffer.from(response.data);
      }
    } catch (error) {
      throw new Error('Failed to take screenshot');
    }
  },
  
  // Text to Speech API
  textToSpeech: async (text) => {
    try {
      const apiUrl = `https://www.laurine.site/api/tts/tts-nova?text=${encodeURIComponent(text)}`;
      const response = await axios.get(apiUrl, {
        timeout: 30000,
        headers: {
          'accept': '*/*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.data) {
        // Check if response.data is a string (direct URL)
        if (typeof response.data === 'string' && (response.data.startsWith('http://') || response.data.startsWith('https://'))) {
          return response.data;
        }
        
        // Check nested data structure
        if (response.data.data) {
          const data = response.data.data;
          if (data.URL) return data.URL;
          if (data.url) return data.url;
          if (data.MP3) return `https://ttsmp3.com/created_mp3_ai/${data.MP3}`;
          if (data.mp3) return `https://ttsmp3.com/created_mp3_ai/${data.mp3}`;
        }
        
        // Check top-level URL fields
        if (response.data.URL) return response.data.URL;
        if (response.data.url) return response.data.url;
        if (response.data.MP3) return `https://ttsmp3.com/created_mp3_ai/${response.data.MP3}`;
        if (response.data.mp3) return `https://ttsmp3.com/created_mp3_ai/${response.data.mp3}`;
      }
      
      throw new Error('Invalid API response structure');
    } catch (error) {
      throw new Error(`Failed to generate speech: ${error.message}`);
    }
  }
};

module.exports = APIs;
