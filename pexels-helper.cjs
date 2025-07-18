// ==== SECTION 1: SETUP & DEPENDENCIES ====
require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

console.log('[Pexels Helper] Loaded – bulletproof fallback mode.');

// ==== SECTION 2: CONFIGURATION & GLOBALS ====
const STOP_WORDS = new Set([
  'and','the','with','into','for','a','to','of','in','on','at','by','from','is','are','was','were','be','has','have','had'
]);

const R2_BUCKET = process.env.R2_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!R2_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[Pexels Helper] WARNING: R2 credentials are missing or invalid! Cloud video matching will fail.');
}
if (!PEXELS_API_KEY) {
  console.warn('[Pexels Helper] WARNING: Pexels API Key not set! No Pexels fallback available.');
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

const LOCAL_CLIP_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(LOCAL_CLIP_DIR)) {
  console.warn(`[Pexels Helper] WARNING: Local clips folder (${LOCAL_CLIP_DIR}) does not exist!`);
}

// ==== SECTION 3: TEXT & SUBJECT HELPERS ====

function sanitizeQuery(raw, maxWords = 10) {
  const cleaned = raw
    .replace(/["“”‘’.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
  console.log(`[sanitizeQuery] Cleaned: "${cleaned}"`);
  return cleaned;
}

async function extractMainSubject(line) {
  let match = line.match(/bald\s*eagle/i);
  if (match) return 'bald eagle';
  match = line.match(/eagle/i);
  if (match) return 'eagle';
  match = line.match(/cat|dog|owl|lion|tiger|shark|snake|wolf|bear|fox|monkey|horse|dolphin|fish|penguin|whale/i);
  if (match) return match[0].toLowerCase();
  let words = sanitizeQuery(line, 2).split(' ');
  return words.join(' ') || 'nature';
}

// ==== SECTION 4: DOWNLOADERS & FILE HELPERS ====

async function downloadToLocal(urls, workDir = TEMP_DIR) {
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
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 15000 });
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

// ==== SECTION 5: REMOTE VIDEO FETCHERS (R2, PEXELS, PIXABAY) ====

async function findBestVideoFromR2(subject) {
  if (!R2_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.warn('[findBestVideoFromR2] R2 credentials not configured, skipping.');
    return null;
  }
  try {
    let allKeys = [], token;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET,
        Prefix: '', // You can set e.g. 'socialstorm-library/' if needed
        ContinuationToken: token
      }));
      const keys = (resp.Contents || [])
        .filter(obj => /\.(mp4|mov|webm|mkv)$/i.test(obj.Key))
        .map(obj => obj.Key);
      allKeys.push(...keys);
      token = resp.NextContinuationToken;
    } while (token);

    if (!allKeys.length) {
      console.warn('[findBestVideoFromR2] No videos found in R2.');
      return null;
    }
    const subjectFlat = subject.replace(/\s+/g, '').toLowerCase();
    // Strict match
    let matches = allKeys.filter(k => k.toLowerCase().includes(subjectFlat));
    if (matches.length > 0) {
      const key = matches[Math.floor(Math.random() * matches.length)];
      const url = `https://${R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
      console.log(`[findBestVideoFromR2] Strict subject match: ${key}`);
      return url;
    }
    // Fuzzy match
    const best = stringSimilarity.findBestMatch(subject.toLowerCase(), allKeys.map(k => k.toLowerCase()));
    const key = best.bestMatch.rating > 0.13 ? allKeys[best.bestMatchIndex] : null;
    if (key) {
      const url = `https://${R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
      console.log(`[findBestVideoFromR2] Fuzzy fallback: ${key} (score: ${best.bestMatch.rating.toFixed(2)})`);
      return url;
    }
    // Random fallback
    if (allKeys.length > 0) {
      const key = allKeys[Math.floor(Math.random() * allKeys.length)];
      const url = `https://${R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
      console.log(`[findBestVideoFromR2] Random fallback: ${key}`);
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
    const query = subject + '';
    const response = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query, per_page: 7 },
      timeout: 10000
    });

    const videos = response.data.videos || [];
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

// Optionally, add Pixabay fallback here if you have API key/setup
async function getPixabayVideo(subject) {
  const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
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

// ==== SECTION 6: LOCAL LIBRARY & FUZZY FALLBACKS ====

function getLocalFallback(subject) {
  try {
    if (!fs.existsSync(LOCAL_CLIP_DIR)) {
      console.warn('[getLocalFallback] Local clips folder missing.');
      return null;
    }
    const files = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (!files.length) {
      console.warn('[getLocalFallback] No .mp4 files in local clips!');
      return null;
    }
    // Strict subject match
    let strict = files.filter(f => f.toLowerCase().includes(subject.replace(/\s+/g, '').toLowerCase()));
    if (strict.length > 0) {
      const pick = strict[Math.floor(Math.random() * strict.length)];
      const local = path.join(LOCAL_CLIP_DIR, pick);
      console.log(`[getLocalFallback] Picked subject match: ${local}`);
      return local;
    }
    // Fuzzy match
    const best = stringSimilarity.findBestMatch(subject.toLowerCase(), files.map(f => f.toLowerCase()));
    if (best.bestMatch && best.bestMatch.rating > 0.13) {
      const fuzzyFile = files[best.bestMatchIndex];
      if (fuzzyFile) {
        console.warn(`[getLocalFallback] Fuzzy subject fallback: ${fuzzyFile} (score: ${best.bestMatch.rating.toFixed(2)})`);
        return path.join(LOCAL_CLIP_DIR, fuzzyFile);
      }
    }
    // Absolute random .mp4 fallback
    if (files.length > 0) {
      const random = files[Math.floor(Math.random() * files.length)];
      console.warn(`[getLocalFallback] Random .mp4 fallback: ${random}`);
      return path.join(LOCAL_CLIP_DIR, random);
    }
  } catch (e) {
    console.warn('[getLocalFallback] error:', e.message);
  }
  return null;
}

function getGenericFallback() {
  // Try "default.mp4" first
  const fallback1 = path.join(LOCAL_CLIP_DIR, 'default.mp4');
  if (fs.existsSync(fallback1)) {
    console.warn('[getGenericFallback] Using default.mp4 fallback');
    return fallback1;
  }
  // Try any .mp4 in the folder, totally random
  try {
    const allFiles = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (allFiles.length > 0) {
      const random = allFiles[Math.floor(Math.random() * allFiles.length)];
      console.warn('[getGenericFallback] Using any random fallback:', random);
      return path.join(LOCAL_CLIP_DIR, random);
    }
  } catch (e) {}
  return null;
}

// ==== SECTION 7: MAIN PICK LOGIC (ENTRY POINT) ====

async function pickClipFor(query) {
  console.log(`[pickClipFor] Query: ${query}`);
  let subject = await extractMainSubject(query);
  if (!subject) {
    console.warn(`[pickClipFor] No subject found, defaulting to nature`);
    subject = 'nature';
  }

  // PRIORITY: 1. R2  2. Local Library  3. Pexels  4. Pixabay  5. Generic fallback

  // Try R2 first (downloads remote files locally if needed)
  const r2url = await findBestVideoFromR2(subject);
  if (r2url) {
    const localR2 = await downloadToLocal(r2url);
    if (localR2) {
      console.log(`[pickClipFor] Found from R2: ${localR2}`);
      return { url: localR2, source: 'r2', subject };
    }
  }

  // Try local library next (subject strict/fuzzy/random)
  const localFallback = getLocalFallback(subject);
  if (localFallback) {
    console.log(`[pickClipFor] Using local library fallback: ${localFallback}`);
    return { url: localFallback, source: 'local', subject };
  }

  // Try Pexels
  const pexelsUrl = await getPexelsVideo(subject);
  if (pexelsUrl) {
    const localPexels = await downloadToLocal(pexelsUrl);
    if (localPexels) {
      console.log(`[pickClipFor] Found from Pexels: ${localPexels}`);
      return { url: localPexels, source: 'pexels', subject };
    }
  }

  // Try Pixabay (optional)
  const pixabayUrl = await getPixabayVideo(subject);
  if (pixabayUrl) {
    const localPixabay = await downloadToLocal(pixabayUrl);
    if (localPixabay) {
      console.log(`[pickClipFor] Found from Pixabay: ${localPixabay}`);
      return { url: localPixabay, source: 'pixabay', subject };
    }
  }

  // Ultimate fallback: any default or random .mp4
  const genericFallback = getGenericFallback();
  if (genericFallback) {
    console.warn(`[pickClipFor] Using generic fallback: ${genericFallback}`);
    return { url: genericFallback, source: 'generic', subject };
  }

  // If *absolutely nothing* found, log error and return null
  console.error(`[pickClipFor] TOTAL FAILURE: No video found for subject "${subject}"`);
  return null;
}

// ==== SECTION 8: EXPORTS ====
module.exports = { pickClipFor };
