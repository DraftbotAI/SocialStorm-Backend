// =============================
// PEXELS HELPER – BULLETPROOF EDITION
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

// Ensure tmp directory exists
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
  return cleaned;
}

// Extract main subject with fallback
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
    let subject = resp.choices[0].message.content.trim().toLowerCase();
    if (subject.includes('\n')) subject = subject.split('\n')[0].trim();
    const cleaned = subject.replace(/[^a-z0-9 ]+/gi, '').trim();
    if (!cleaned) throw new Error("No subject found");
    console.log(`[extractMainSubject] "${cleaned}"`);
    return cleaned;
  } catch (err) {
    console.warn('[extractMainSubject fallback]:', err.message);
    return sanitizeQuery(line, 3).split(' ')[0] || 'nature';
  }
}

// Download a remote video to a local temp file and return the local path
async function downloadToLocal(url, workDir = TEMP_DIR) {
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
  const fileName = `remote_${hash}_${Date.now()}.mp4`;
  const dest = path.join(workDir, fileName);
  if (fs.existsSync(dest)) {
    console.log(`[downloadToLocal] Already downloaded: ${dest}`);
    return dest;
  }
  try {
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 15000,
      maxContentLength: 200 * 1024 * 1024, // 200MB safety limit
    });
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(dest);
      response.data.pipe(w);
      w.on('finish', resolve);
      w.on('error', reject);
    });
    console.log(`[downloadToLocal] Downloaded ${url} to ${dest}`);
    return dest;
  } catch (err) {
    console.error(`[downloadToLocal] Failed to download ${url}:`, err.message);
    return null;
  }
}

// Promise timeout
function promiseTimeout(promise, ms, msg = "Timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => {
      console.warn(`[promiseTimeout] Timed out after ${ms}ms: ${msg}`);
      reject(new Error(msg));
    }, ms))
  ]);
}

// Fuzzy R2 finder – returns best match or random fallback
async function findBestVideoFromR2(mainSubject, bucket = process.env.R2_BUCKET) {
  try {
    let continuationToken = undefined;
    let allKeys = [];
    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken
      }));
      const keys = (resp.Contents || [])
        .filter(obj => /\.(mp4|mov|webm|mkv)$/i.test(obj.Key))  // Ensure we’re only looking at video files
        .map(obj => obj.Key);  // Get the filenames of the videos
      allKeys.push(...keys);
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    if (allKeys.length === 0) {
      console.warn(`[findBestVideoFromR2] No video keys found in R2 bucket.`);
      return null;
    }

    // Fuzzy match with lowered threshold for better matching on partial keywords
    const names = allKeys.map(k => k.toLowerCase());  // Normalize file names
    const best = stringSimilarity.findBestMatch(mainSubject.toLowerCase(), names);  // Find the best match

    if (best.bestMatch.rating > 0.1) {  // Set a threshold for a good match
      const key = allKeys[best.bestMatchIndex];  // Use the best matched video
      const url = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
      console.log(`[findBestVideoFromR2] Fuzzy match "${mainSubject}" to "${key}" (score: ${best.bestMatch.rating.toFixed(2)})`);
      return url;
    }

    // Otherwise, random fallback
    const fallbackKey = allKeys[Math.floor(Math.random() * allKeys.length)];
    const fallbackUrl = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${fallbackKey}`;
    console.log(`[findBestVideoFromR2] No good match, using random fallback: ${fallbackKey}`);
    return fallbackUrl;
  } catch (err) {
    console.warn(`[findBestVideoFromR2] error:`, err.message);
    return null;
  }
}

// Pexels video search by main subject
async function getPexelsVideo(mainSubject) {
  try {
    const resp = await promiseTimeout(
      axios.get('https://api.pexels.com/videos/search', {
        headers: { Authorization: process.env.PEXELS_API_KEY },
        params: { query: mainSubject, per_page: 8 },
        timeout: 9000
      }),
      10000,
      "Pexels video search timed out"
    );
    const vids = resp.data.videos || [];
    if (vids.length) {
      // Sort videos so the ones with portrait or near square aspect ratios come first
      vids.sort((a, b) => {
        const aAR = (a.width && a.height) ? a.height / a.width : 0;
        const bAR = (b.width && b.height) ? b.height / b.width : 0;
        // Prioritize aspect ratios close to 1 (square/portrait)
        return Math.abs(bAR - 1) - Math.abs(aAR - 1);
      });
      const top = vids[0];
      // Prefer HD or SD quality with vertical or square aspect ratio
      const vf = (top.video_files || []).find(f => (f.quality === "hd" || f.quality === "sd") && f.height >= 720 && f.width <= 900) || (top.video_files || [])[0];
      if (vf && vf.link) {
        console.log(`[getPexelsVideo] Found "${mainSubject}" video: ${vf.link}`);
        return vf.link;
      }
    }
    console.warn(`[getPexelsVideo] No suitable video found for "${mainSubject}"`);
    return null;
  } catch (err) {
    console.warn(`[getPexelsVideo] error for "${mainSubject}":`, err.message);
    return null;
  }
}

// Pixabay video search by main subject
async function getPixabayVideo(mainSubject) {
  try {
    const resp = await promiseTimeout(
      axios.get('https://pixabay.com/api/videos/', {
        params: {
          key: process.env.PIXABAY_API_KEY,
          q: mainSubject,
          safesearch: true,
          per_page: 8,
          lang: 'en',
          video_type: 'all'
        },
        timeout: 9000
      }),
      10000,
      "Pixabay video search timed out"
    );
    if (resp.data && Array.isArray(resp.data.hits) && resp.data.hits.length > 0) {
      // Sort hits to prioritize portrait or near-square aspect ratio
      resp.data.hits.sort((a, b) => {
        const aAR = (a.videos.large?.width && a.videos.large?.height) ? a.videos.large.height / a.videos.large.width : 0;
        const bAR = (b.videos.large?.width && b.videos.large?.height) ? b.videos.large.height / b.videos.large.width : 0;
        return Math.abs(bAR - 1) - Math.abs(aAR - 1);
      });
      const vid = resp.data.hits[0];
      const videoUrl =
        (vid.videos.large && vid.videos.large.url) ||
        (vid.videos.medium && vid.videos.medium.url) ||
        (vid.videos.tiny && vid.videos.tiny.url) || '';
      if (videoUrl) {
        console.log(`[getPixabayVideo] Found "${mainSubject}" video: ${videoUrl}`);
        return videoUrl;
      }
    }
    console.warn(`[getPixabayVideo] No suitable video found for "${mainSubject}"`);
    return null;
  } catch (err) {
    console.warn(`[getPixabayVideo] error for "${mainSubject}":`, err.message);
    return null;
  }
}

// Local fallback (random mp4 from /clips)
function getLocalFallback() {
  try {
    if (fs.existsSync(LOCAL_CLIP_DIR)) {
      const files = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
      if (files.length) {
        shuffleArray(files);
        const fallbackPath = path.join(LOCAL_CLIP_DIR, files[0]);
        console.log(`[getLocalFallback] Using local fallback: ${fallbackPath}`);
        return fallbackPath;
      }
    }
  } catch (err) {
    console.warn(`[getLocalFallback] search failed:`, err.message);
  }
  return null;
}

// Generic fallback (from bundled fallback video or error)
function getGenericFallback() {
  const fallback = path.join(__dirname, 'fallback.mp4');
  if (fs.existsSync(fallback)) {
    console.log(`[getGenericFallback] Using bundled fallback.mp4`);
    return fallback;
  }
  console.error(`[getGenericFallback] TOTAL FAIL – No video found anywhere.`);
  return null;
}

// Shuffle array utility
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ========== UNIVERSAL, NEVER-FAIL PICK CLIP FUNCTION ========== 
async function pickClipFor(rawQuery, tempDir = TEMP_DIR, minScore = 0.13, mainSubject = '', excludeUrls = []) {
  console.log(`[pickClipFor] rawQuery="${rawQuery}"`);

  // Extract main subject (always, never skip)
  let subject = mainSubject;
  if (!subject) subject = await extractMainSubject(rawQuery);
  if (!subject) subject = 'nature';

  // 1. R2 library first
  let r2Url = await findBestVideoFromR2(subject);
  if (r2Url) {
    const localPath = await downloadToLocal(r2Url, tempDir);
    if (localPath) {
      return {
        type: 'video',
        url: localPath,
        originalUrl: r2Url,
        source: 'cloud_library'
      };
    }
    // If download failed, continue to next source
  }

  // 2. Pexels next
  let pexelsUrl = await getPexelsVideo(subject);
  if (pexelsUrl) {
    const localPath = await downloadToLocal(pexelsUrl, tempDir);
    if (localPath) {
      return {
        type: 'video',
        url: localPath,
        originalUrl: pexelsUrl,
        source: 'pexels'
      };
    }
  }

  // 3. Pixabay last
  let pixabayUrl = await getPixabayVideo(subject);
  if (pixabayUrl) {
    const localPath = await downloadToLocal(pixabayUrl, tempDir);
    if (localPath) {
      return {
        type: 'video',
        url: localPath,
        originalUrl: pixabayUrl,
        source: 'pixabay'
      };
    }
  }

  // 4. Local fallback dir
  const localFallback = getLocalFallback();
  if (localFallback) {
    return {
      type: 'video',
      url: localFallback,
      source: 'local_fallback'
    };
  }

  // 5. Generic fallback (should always exist)
  const genericFallback = getGenericFallback();
  if (genericFallback) {
    return {
      type: 'video',
      url: genericFallback,
      source: 'generic_fallback'
    };
  }

  // 6. Nothing worked (should never reach here)
  console.error(`[pickClipFor] TOTAL FAIL — No video found for "${rawQuery}" (subject="${subject}")`);
  return null;
}

// ========== EXPORT ==========
module.exports = { pickClipFor };
console.log('[Pexels Helper] Exported pickClipFor function.');
