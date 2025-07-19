console.log('[DEBUG] DEPLOY TEST', new Date());

// ==== SECTION 1: SETUP & DEPENDENCIES ====
require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

console.log('[Pexels Helper] Loaded – GOD TIER MATCHING ENABLED.');

// ==== SECTION 2: CONFIGURATION & GLOBALS ====
const STOP_WORDS = new Set([
  'and','the','with','into','for','a','to','of','in','on','at','by','from','is','are','was','were','be','has','have','had'
]);

// **THIS IS THE LINE THAT MATTERS:**
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || process.env.R2_BUCKET; // <-- Always set R2_LIBRARY_BUCKET=socialstorm-library in your .env!
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;
const R2_PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || 'https://pub-5d04f1b3024299b5953e63a9555fb8.r2.dev';

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;

if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[Pexels Helper] WARNING: R2 credentials are missing or invalid! Cloud video matching will fail.');
}
if (!PEXELS_API_KEY) {
  console.warn('[Pexels Helper] WARNING: Pexels API Key not set! No Pexels fallback available.');
}
if (!PIXABAY_KEY) {
  console.warn('[Pexels Helper] WARNING: Pixabay API Key not set! No Pixabay fallback available.');
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ==== SECTION 3: SMART SUBJECT/CLIP MAPPINGS ====
// (Edit/add here as you grow the library!)
const CUSTOM_KEYWORDS = {
  'sandwich': ['sandwich', 'sub', 'hoagie', 'deli', 'bread'],
  'owl': ['owl', 'owlet'],
  'cat': ['cat', 'kitten', 'tabby'],
  'dog': ['dog', 'puppy'],
  'pizza': ['pizza', 'slice'],
  'burger': ['burger', 'cheeseburger', 'hamburger'],
  'salad': ['salad', 'greens'],
  'beach': ['beach', 'ocean', 'seashore'],
  'mountain': ['mountain', 'alps', 'rocky'],
  // Add more for new categories as needed!
};

// ==== SECTION 4: TEXT & SUBJECT HELPERS ====

function extractMainSubject(lineRaw) {
  let line = (lineRaw || '').toLowerCase().replace(/[^\w\s]/gi, ' ');
  for (const key in CUSTOM_KEYWORDS) {
    for (const token of CUSTOM_KEYWORDS[key]) {
      if (line.includes(token)) {
        console.log(`[extractMainSubject] Matched custom subject "${key}" with token "${token}"`);
        return key;
      }
    }
  }
  const match = line.match(/(bald\s*eagle|eagle|cat|dog|owl|lion|tiger|shark|snake|wolf|bear|fox|monkey|horse|dolphin|fish|penguin|whale|pizza|burger|sandwich|salad|beach|mountain|sunset|lake|forest|desert|car|train|plane)/i);
  if (match) {
    console.log(`[extractMainSubject] Regex matched: ${match[0].toLowerCase()}`);
    return match[0].toLowerCase();
  }
  let words = sanitizeQuery(lineRaw, 2).split(' ');
  let subject = words.join(' ') || 'nature';
  console.log(`[extractMainSubject] Fallback subject: ${subject}`);
  return subject;
}

function sanitizeQuery(raw, maxWords = 10) {
  const cleaned = (raw || '')
    .replace(/["“”‘’.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
  return cleaned;
}

// ==== SECTION 5: DOWNLOADERS & FILE HELPERS ====
async function downloadToLocal(urls, workDir = './tmp') {
  if (!urls) return null;
  if (!Array.isArray(urls)) urls = [urls];
  const downloaded = [];
  for (let url of urls) {
    try {
      if (!url) continue;
      const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
      const fileName = `clip_${hash}_${Date.now()}.mp4`;
      const dest = path.join(workDir, fileName);

      if (fs.existsSync(dest)) {
        console.log(`[downloadToLocal] Already exists: ${dest}`);
        downloaded.push(dest);
        continue;
      }

      console.log(`[downloadToLocal] Downloading ${url}`);
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 20000 });
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (fs.existsSync(dest)) {
        console.log(`[downloadToLocal] Saved: ${dest}`);
        downloaded.push(dest);
      } else {
        console.error(`[downloadToLocal] File not saved: ${dest}`);
      }
    } catch (err) {
      console.error(`[downloadToLocal] Error downloading ${url}: ${err.message}`);
    }
  }
  return downloaded.length > 0 ? downloaded[0] : null;
}

// ==== SECTION 6: REMOTE VIDEO FETCHERS (R2, PEXELS, PIXABAY) ====

async function findBestVideoFromR2(subject) {
  if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.warn('[findBestVideoFromR2] R2 credentials are missing or invalid! Skipping.');
    return null;
  }
  try {
    let allKeys = [], token;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: 'socialstorm-library/', // Set this to your library folder prefix
        ContinuationToken: token
      }));
      const keys = (resp.Contents || [])
        .filter(obj => /\.(mp4|mov|webm|mkv)$/i.test(obj.Key))
        .map(obj => obj.Key.replace(/^socialstorm-library\//, ''));
      allKeys.push(...keys);
      token = resp.NextContinuationToken;
    } while (token);

    if (!allKeys.length) {
      console.warn('[findBestVideoFromR2] No videos found in R2.');
      return null;
    }

    let matchKey = null;
    if (CUSTOM_KEYWORDS[subject]) {
      for (const token of CUSTOM_KEYWORDS[subject]) {
        matchKey = allKeys.find(k => k.toLowerCase().includes(token));
        if (matchKey) {
          console.log(`[findBestVideoFromR2] Custom keyword match: ${matchKey}`);
          break;
        }
      }
    }
    if (!matchKey) {
      const subjectFlat = subject.replace(/\s+/g, '').toLowerCase();
      const matches = allKeys.filter(k => k.toLowerCase().includes(subjectFlat));
      if (matches.length > 0) {
        matchKey = matches[Math.floor(Math.random() * matches.length)];
        console.log(`[findBestVideoFromR2] Strict subject match: ${matchKey}`);
      }
    }
    if (!matchKey) {
      const best = stringSimilarity.findBestMatch(subject.toLowerCase(), allKeys.map(k => k.toLowerCase()));
      if (best.bestMatch.rating > 0.13) {
        matchKey = allKeys[best.bestMatchIndex];
        console.log(`[findBestVideoFromR2] Fuzzy fallback: ${matchKey} (score: ${best.bestMatch.rating.toFixed(2)})`);
      }
    }
    if (!matchKey && allKeys.length > 0) {
      matchKey = allKeys[Math.floor(Math.random() * allKeys.length)];
      console.log(`[findBestVideoFromR2] Random fallback: ${matchKey}`);
    }

    if (matchKey) {
      const url = `${R2_PUBLIC_DOMAIN}/socialstorm-library/${matchKey}`.replace(/([^:]\/)\/+/g, "$1");
      return url;
    }
    return null;
  } catch (err) {
    console.error(`[findBestVideoFromR2] R2 error: ${err.message}`);
    return null;
  }
}

async function getPexelsVideo(subject) {
  if (!PEXELS_API_KEY) {
    console.warn('[getPexelsVideo] No Pexels API key!');
    return null;
  }
  try {
    const response = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query: subject, per_page: 7 },
      timeout: 10000
    });

    const videos = response.data.videos || [];
    console.log(`[getPexelsVideo] Queried Pexels for "${subject}" and got ${videos.length} results.`);
    if (videos.length === 0) {
      console.warn(`[getPexelsVideo] No results from Pexels for "${subject}".`);
    }
    const subjectFlat = subject.replace(/\s+/g, '').toLowerCase();
    let top = videos.find(v =>
      v.tags?.some(tag => tag.title?.toLowerCase().includes(subjectFlat)) ||
      (v.user?.name && v.user.name.toLowerCase().includes(subjectFlat))
    );
    if (!top) {
      top = videos.find(v =>
        v.video_files?.some(f => f.link.toLowerCase().includes(subjectFlat))
      );
    }
    const link = top?.video_files?.[0]?.link;
    if (link) console.log(`[getPexelsVideo] Strict subject found: ${link}`);
    return link || null;
  } catch (err) {
    console.warn(`[getPexelsVideo] error: ${err.message}`);
    return null;
  }
}

async function getPixabayVideo(subject) {
  if (!PIXABAY_KEY) {
    console.warn('[getPixabayVideo] No Pixabay API key!');
    return null;
  }
  try {
    const response = await axios.get('https://pixabay.com/api/videos/', {
      params: {
        key: PIXABAY_KEY,
        q: subject,
        safesearch: true,
        per_page: 7
      },
      timeout: 10000
    });
    const videos = response.data.hits || [];
    if (videos.length > 0) {
      const link = videos[0].videos.medium.url;
      if (link) console.log(`[getPixabayVideo] Fallback found: ${link}`);
      return link;
    }
    return null;
  } catch (err) {
    console.warn(`[getPixabayVideo] error: ${err.message}`);
    return null;
  }
}

// ==== SECTION 6: MAIN PICK LOGIC (ENTRY POINT) ====
// Priority: 1. R2_LIBRARY_BUCKET  2. Pexels  3. Pixabay
async function pickClipFor(query) {
  console.log(`[pickClipFor] Query: ${query}`);
  let subject = extractMainSubject(query);
  if (!subject) {
    console.warn(`[pickClipFor] No subject found, defaulting to nature`);
    subject = 'nature';
  }

  // Try R2_LIBRARY_BUCKET first (returns public URL)
  const r2url = await findBestVideoFromR2(subject);
  if (r2url) {
    console.log(`[pickClipFor] Found from R2: ${r2url}`);
    return { url: r2url, source: 'r2', subject };
  }

  // Try Pexels
  const pexelsUrl = await getPexelsVideo(subject);
  if (pexelsUrl) {
    console.log(`[pickClipFor] Found from Pexels: ${pexelsUrl}`);
    return { url: pexelsUrl, source: 'pexels', subject };
  }

  // Try Pixabay
  const pixabayUrl = await getPixabayVideo(subject);
  if (pixabayUrl) {
    console.log(`[pickClipFor] Found from Pixabay: ${pixabayUrl}`);
    return { url: pixabayUrl, source: 'pixabay', subject };
  }

  // Nothing found
  console.error(`[pickClipFor] TOTAL FAILURE: No video found for subject "${subject}"`);
  return null;
}

// ==== SECTION 7: EXPORTS ====
module.exports = { pickClipFor };
