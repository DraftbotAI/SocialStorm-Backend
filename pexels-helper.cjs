// ==== SECTION 1: SETUP & DEPENDENCIES ====
require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

console.log('[Pexels Helper] Loaded – strict subject filter mode.');



 
// ==== SECTION 2: CONFIGURATION & GLOBALS ====
const STOP_WORDS = new Set([
  'and','the','with','into','for','a','to','of','in','on','at','by','from','is','are','was','were','be','has','have','had'
]);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const LOCAL_CLIP_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TEMP_DIR, { recursive: true });



 
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
  if (!Array.isArray(urls)) urls = [urls];
  const downloaded = [];

  for (let url of urls) {
    try {
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

      console.log(`[downloadToLocal] Saved: ${dest}`);
      downloaded.push(dest);
    } catch (err) {
      console.error(`[downloadToLocal] Error downloading ${url}: ${err.message}`);
    }
  }

  return downloaded.length > 0 ? downloaded[0] : null;
}



 
// ==== SECTION 5: REMOTE VIDEO FETCHERS (R2, PEXELS) ====

async function findBestVideoFromR2(subject) {
  try {
    let allKeys = [], token;
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        ContinuationToken: token
      }));
      const keys = (resp.Contents || [])
        .filter(obj => /\.(mp4|mov|webm|mkv)$/i.test(obj.Key))
        .map(obj => obj.Key);
      allKeys.push(...keys);
      token = resp.NextContinuationToken;
    } while (token);

    const subjectFlat = subject.replace(/\s+/g, '').toLowerCase();
    let matches = allKeys.filter(k => k.toLowerCase().includes(subjectFlat));
    if (matches.length > 0) {
      const key = matches[Math.floor(Math.random() * matches.length)];
      const url = `https://${process.env.R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
      console.log(`[findBestVideoFromR2] Strict subject match: ${key}`);
      return url;
    }

    const best = stringSimilarity.findBestMatch(subject.toLowerCase(), allKeys.map(k => k.toLowerCase()));
    const key = best.bestMatch.rating > 0.2 ? allKeys[best.bestMatchIndex] : null;
    if (key) {
      const url = `https://${process.env.R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
      console.log(`[findBestVideoFromR2] Fuzzy fallback: ${key}`);
      return url;
    }

    if (allKeys.length > 0) {
      const key = allKeys[Math.floor(Math.random() * allKeys.length)];
      const url = `https://${process.env.R2_BUCKET}.r2.cloudflarestorage.com/${key}`;
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
  try {
    const query = subject + '';
    const response = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
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



 
// ==== SECTION 6: LOCAL LIBRARY FALLBACKS ====

function getLocalFallback(subject) {
  try {
    const files = fs.readdirSync(LOCAL_CLIP_DIR)
      .filter(f => f.endsWith('.mp4') && f.toLowerCase().includes(subject.replace(/\s+/g, '').toLowerCase()));
    if (files.length > 0) {
      const pick = files[Math.floor(Math.random() * files.length)];
      const local = path.join(LOCAL_CLIP_DIR, pick);
      console.log(`[getLocalFallback] Picked subject match: ${local}`);
      return local;
    }
    const list = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (list.length > 0) {
      const random = list[Math.floor(Math.random() * list.length)];
      const local = path.join(LOCAL_CLIP_DIR, random);
      console.log(`[getLocalFallback] Picked generic local: ${local}`);
      return local;
    }
  } catch (e) {
    console.warn('[getLocalFallback] error:', e.message);
  }
  return null;
}

function getGenericFallback() {
  // Now enforces presence of a default fallback clip.
  const fallback1 = path.join(__dirname, 'clips', 'default.mp4');
  if (fs.existsSync(fallback1)) {
    console.warn('[getGenericFallback] Using default.mp4 fallback');
    return fallback1;
  }
  // Legacy fallback (optional, remove if not used)
  const fallback2 = path.join(__dirname, 'fallback.mp4');
  if (fs.existsSync(fallback2)) {
    console.warn('[getGenericFallback] Using fallback.mp4');
    return fallback2;
  }
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

  // Try R2 and Pexels first (downloads remote files locally if needed)
  const sources = [
    { name: 'R2', fetch: () => findBestVideoFromR2(subject) },
    { name: 'Pexels', fetch: () => getPexelsVideo(subject) }
  ];

  for (let src of sources) {
    const url = await src.fetch();
    if (url) {
      const local = await downloadToLocal(url);
      if (local) {
        console.log(`[pickClipFor] Found from ${src.name}: ${local}`);
        return { url: local, source: src.name.toLowerCase(), subject };
      }
    }
  }

  // Try local library next
  const localFallback = getLocalFallback(subject);
  if (localFallback) {
    console.log(`[pickClipFor] Using local library fallback: ${localFallback}`);
    return { url: localFallback, source: 'local_fallback', subject };
  }

  // Bulletproof: If even that fails, use default fallback!
  const genericFallback = getGenericFallback();
  if (genericFallback) {
    console.warn(`[pickClipFor] Using generic fallback: ${genericFallback}`);
    return { url: genericFallback, source: 'generic_fallback', subject };
  }

  // If *absolutely nothing* found, log error and return null
  console.error(`[pickClipFor] TOTAL FAILURE: No video found for subject "${subject}"`);
  return null;
}



 
// ==== SECTION 8: EXPORTS ====
module.exports = { pickClipFor };
