// =============================
// PEXELS HELPER – BULLETPROOF EDITION
// =============================

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

console.log('[PEXELS-HELPER] Dependencies loaded.');

// ========== CONSTANTS ==========

const LOCAL_CLIP_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TEMP_DIR, { recursive: true });

const STOP_WORDS = new Set(['and','the','with','into','for','a','to','of','in','on','at','by','from','is','are','was','were','be','has','have','had']);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// ========== HELPERS ==========

function ensureArray(urls) {
  if (Array.isArray(urls)) return urls;
  return [urls];
}

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
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: "Extract the single main subject of this script in 1-2 words, lowercase, no hashtags, no punctuation, no verbs. Only return the subject." },
        { role: 'user', content: line }
      ],
      temperature: 0.1,
      max_tokens: 8
    });
    const subject = resp.choices[0].message.content.trim().toLowerCase();
    const cleaned = subject.replace(/[^a-z0-9 ]+/gi, '').trim();
    console.log(`[extractMainSubject] "${cleaned}"`);
    return cleaned || sanitizeQuery(line, 3).split(' ')[0] || 'nature';
  } catch (err) {
    console.warn('[extractMainSubject fallback]:', err.message);
    return sanitizeQuery(line, 3).split(' ')[0] || 'nature';
  }
}

function promiseTimeout(promise, ms, msg = "Timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      console.warn(`[promiseTimeout] ${msg} after ${ms}ms`);
      reject(new Error(msg));
    }, ms))
  ]);
}

async function downloadToLocal(urls, workDir = TEMP_DIR) {
  const downloaded = [];

  for (const url of ensureArray(urls)) {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    const dest = path.join(workDir, `remote_${hash}_${Date.now()}.mp4`);

    try {
      const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 15000 });
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(dest);
        response.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
      });
      console.log(`[downloadToLocal] Downloaded: ${dest}`);
      downloaded.push(dest);
    } catch (err) {
      console.warn(`[downloadToLocal] Failed: ${url}`, err.message);
      downloaded.push(null);
    }
  }

  return downloaded.length === 1 ? downloaded[0] : downloaded;
}

async function findBestVideoFromR2(subject) {
  try {
    let continuationToken;
    let allKeys = [];

    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: process.env.R2_BUCKET,
        ContinuationToken: continuationToken
      }));
      const keys = (resp.Contents || [])
        .filter(obj => /\.(mp4|mov|webm)$/i.test(obj.Key))
        .map(obj => obj.Key);
      allKeys.push(...keys);
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    if (!allKeys.length) return null;

    const names = allKeys.map(k => k.toLowerCase());
    const best = stringSimilarity.findBestMatch(subject.toLowerCase(), names);

    if (best.bestMatch.rating > 0.1) {
      const key = allKeys[best.bestMatchIndex];
      const url = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${key}`;
      console.log(`[R2] Best match: ${key} (score ${best.bestMatch.rating.toFixed(2)})`);
      return url;
    }

    const fallback = allKeys[Math.floor(Math.random() * allKeys.length)];
    const fallbackUrl = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET}/${fallback}`;
    console.log(`[R2] Fallback used: ${fallback}`);
    return fallbackUrl;
  } catch (err) {
    console.warn('[R2 Error]', err.message);
    return null;
  }
}

async function getPexelsVideo(subject) {
  try {
    const resp = await promiseTimeout(
      axios.get('https://api.pexels.com/videos/search', {
        headers: { Authorization: process.env.PEXELS_API_KEY },
        params: { query: subject, per_page: 8 },
        timeout: 9000
      }),
      10000,
      'Pexels timeout'
    );
    const vids = resp.data.videos || [];
    if (!vids.length) return null;

    vids.sort((a, b) => {
      const aAR = a.height / a.width, bAR = b.height / b.width;
      return Math.abs(bAR - 1) - Math.abs(aAR - 1);
    });

    const top = vids[0];
    const best = (top.video_files || []).find(f => f.height >= 720 && f.width <= 1080) || top.video_files[0];
    return best?.link || null;
  } catch (err) {
    console.warn('[getPexelsVideo]', err.message);
    return null;
  }
}

function getLocalFallback() {
  try {
    const files = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (files.length) {
      const pick = files[Math.floor(Math.random() * files.length)];
      return path.join(LOCAL_CLIP_DIR, pick);
    }
  } catch (err) {
    console.warn('[getLocalFallback]', err.message);
  }
  return null;
}

function getGenericFallback() {
  const fallback = path.join(__dirname, 'fallback.mp4');
  return fs.existsSync(fallback) ? fallback : null;
}

// ========== UNIVERSAL PICK FUNCTION ==========

async function pickClipFor(rawQuery, tempDir = TEMP_DIR, minScore = 0.13, subjectOverride = '') {
  console.log(`[pickClipFor] Started. Query: "${rawQuery}"`);
  const subject = subjectOverride || await extractMainSubject(rawQuery);

  let r2 = await findBestVideoFromR2(subject);
  if (r2) {
    const local = await downloadToLocal(r2, tempDir);
    if (local) return { type: 'video', url: local, originalUrl: r2, source: 'cloud_library' };
  }

  let pex = await getPexelsVideo(subject);
  if (pex) {
    const local = await downloadToLocal(pex, tempDir);
    if (local) return { type: 'video', url: local, originalUrl: pex, source: 'pexels' };
  }

  const localFallback = getLocalFallback();
  if (localFallback) return { type: 'video', url: localFallback, source: 'local_fallback' };

  const generic = getGenericFallback();
  if (generic) return { type: 'video', url: generic, source: 'generic_fallback' };

  console.error(`[pickClipFor] FAILED – No video found`);
  return null;
}

// ========== EXPORT ==========

module.exports = { pickClipFor };
console.log('[PEXELS-HELPER] pickClipFor exported.');
