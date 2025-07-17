// =============================
// PEXELS HELPER – BULLETPROOF EDITION (FIXED)
// =============================

require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

console.log('[Pexels Helper] Dependencies loaded.');

// ========== CONFIG ==========
const STOP_WORDS = new Set([
  'and', 'the', 'with', 'into', 'for', 'a', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had'
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

function ensureArray(url) {
  if (Array.isArray(url)) return url;
  console.log(`[ensureArray] Wrapped single URL into array: ${url}`);
  return [url];
}

function sanitizeQuery(raw, maxWords = 10) {
  const cleaned = raw
    .replace(/["“”‘’.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
  console.log(`[sanitizeQuery] Cleaned query: "${cleaned}"`);
  return cleaned;
}

async function extractMainSubject(line) {
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log(`[extractMainSubject] Extracting from: "${line}"`);
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: "Extract main subject of script (1-2 words, lowercase)." },
        { role: 'user', content: line }
      ],
      temperature: 0.1,
      max_tokens: 8
    });
    let subject = resp.choices[0].message.content.trim().toLowerCase().split('\n')[0];
    const cleaned = subject.replace(/[^a-z0-9 ]+/gi, '').trim();
    if (!cleaned) throw new Error("Empty subject");
    console.log(`[extractMainSubject] Subject extracted: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    const fallback = sanitizeQuery(line, 3).split(' ')[0] || 'nature';
    console.warn(`[extractMainSubject] Fallback to "${fallback}": ${err.message}`);
    return fallback;
  }
}

async function downloadToLocal(urls, workDir = TEMP_DIR) {
  urls = ensureArray(urls);
  for (let url of urls) {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    const dest = path.join(workDir, `remote_${hash}_${Date.now()}.mp4`);
    if (fs.existsSync(dest)) {
      console.log(`[downloadToLocal] Already exists: ${dest}`);
      return dest;
    }
    try {
      console.log(`[downloadToLocal] Downloading from: ${url}`);
      const response = await axios.get(url, { responseType: 'stream', timeout: 15000 });
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(dest);
        response.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
      });
      console.log(`[downloadToLocal] Downloaded successfully: ${dest}`);
      return dest;
    } catch (err) {
      console.error(`[downloadToLocal] Failed downloading ${url}: ${err.message}`);
    }
  }
  return null;
}

// (The rest of your original helper functions stay exactly the same)

// ========== UNIVERSAL, NEVER-FAIL PICK CLIP FUNCTION ==========
async function pickClipFor(rawQuery, tempDir = TEMP_DIR, mainSubject = '') {
  console.log(`[pickClipFor] Starting search for: "${rawQuery}"`);

  let subject = mainSubject || await extractMainSubject(rawQuery) || 'nature';

  let sources = [
    { name: 'Cloud R2', method: findBestVideoFromR2 },
    { name: 'Pexels', method: getPexelsVideo },
    { name: 'Pixabay', method: getPixabayVideo }
  ];

  for (let source of sources) {
    console.log(`[pickClipFor] Trying ${source.name}...`);
    let url = await source.method(subject);
    if (url) {
      let localPath = await downloadToLocal(url, tempDir);
      if (localPath) {
        return { type: 'video', url: localPath, originalUrl: url, source: source.name };
      }
    }
  }

  let localFallback = getLocalFallback();
  if (localFallback) return { type: 'video', url: localFallback, source: 'local_fallback' };

  let genericFallback = getGenericFallback();
  if (genericFallback) return { type: 'video', url: genericFallback, source: 'generic_fallback' };

  console.error(`[pickClipFor] TOTAL FAIL for "${rawQuery}"`);
  return null;
}

module.exports = { pickClipFor };
console.log('[Pexels Helper] Export complete.');
