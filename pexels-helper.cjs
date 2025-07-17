// =============================
// PEXELS HELPER – BULLETPROOF FIXED VERSION
// =============================

require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// === LOG INIT ===
console.log('[Pexels Helper] Loaded with max verbosity.');

// ========== CONFIG ==========
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

// ========== HELPERS ==========

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
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log(`[extractMainSubject] Raw: "${line}"`);
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: "Extract the single main subject of this script in 1-2 words, lowercase, no hashtags, no punctuation, no verbs. Only return the subject." },
        { role: 'user', content: line }
      ],
      temperature: 0.1,
      max_tokens: 8
    });
    const result = resp.choices[0].message.content.trim().toLowerCase();
    const cleaned = result.split('\n')[0].replace(/[^a-z0-9 ]+/gi, '').trim();
    console.log(`[extractMainSubject] Cleaned subject: "${cleaned}"`);
    return cleaned || sanitizeQuery(line, 3).split(' ')[0] || 'nature';
  } catch (err) {
    console.error(`[extractMainSubject] Fallback error: ${err.message}`);
    return sanitizeQuery(line, 3).split(' ')[0] || 'nature';
  }
}

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

    const best = stringSimilarity.findBestMatch(subject.toLowerCase(), allKeys.map(k => k.toLowerCase()));
    const key = best.bestMatch.rating > 0.1 ? allKeys[best.bestMatchIndex] : allKeys[Math.floor(Math.random() * allKeys.length)];

    const url = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${key}`;
    console.log(`[findBestVideoFromR2] Picked: ${key}`);
    return url;
  } catch (err) {
    console.error(`[findBestVideoFromR2] R2 error: ${err.message}`);
    return null;
  }
}

async function getPexelsVideo(subject) {
  try {
    const response = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: subject, per_page: 5 },
      timeout: 10000
    });

    const videos = response.data.videos || [];
    const top = videos.find(v => (v.video_files || []).some(f => f.quality === "hd" && f.height >= 720));
    const link = top?.video_files?.[0]?.link;
    if (link) console.log(`[getPexelsVideo] Found: ${link}`);
    return link || null;
  } catch (err) {
    console.warn(`[getPexelsVideo] error: ${err.message}`);
    return null;
  }
}

function getLocalFallback() {
  try {
    const list = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (list.length > 0) {
      const random = list[Math.floor(Math.random() * list.length)];
      const local = path.join(LOCAL_CLIP_DIR, random);
      console.log(`[getLocalFallback] Picked: ${local}`);
      return local;
    }
  } catch (e) {
    console.warn('[getLocalFallback] error:', e.message);
  }
  return null;
}

function getGenericFallback() {
  const fallback = path.join(__dirname, 'fallback.mp4');
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

// ========== MAIN EXPORT ==========

async function pickClipFor(query) {
  console.log(`[pickClipFor] Query: ${query}`);
  const subject = await extractMainSubject(query);
  if (!subject) {
    console.warn(`[pickClipFor] No subject found, defaulting to nature`);
    subject = 'nature';
  }

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
        return { url: local, source: src.name.toLowerCase() };
      }
    }
  }

  const localFallback = getLocalFallback();
  if (localFallback) return { url: localFallback, source: 'local_fallback' };

  const genericFallback = getGenericFallback();
  if (genericFallback) return { url: genericFallback, source: 'generic_fallback' };

  console.error(`[pickClipFor] TOTAL FAILURE: No video found`);
  return null;
}

module.exports = { pickClipFor };
