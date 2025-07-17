// =============================
// REWRITTEN PEXELS HELPER – CLEANED UP VERSION
// =============================

require('dotenv').config();
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const stringSimilarity = require('string-similarity');

const STOP_WORDS = new Set(['and', 'the', 'with', 'into', 'for', 'a', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had']);

const LOCAL_CLIP_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'tmp');

// Setup for Cloud R2 (local library)
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

// Ensure tmp directory exists
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Helper functions
function sanitizeQuery(raw, maxWords = 10) {
  const cleaned = raw.replace(/["“”‘’.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
  return cleaned;
}

// Function to download multiple URLs to local
async function downloadToLocal(urls, workDir = TEMP_DIR) {
  if (!Array.isArray(urls)) {
    console.warn("[downloadToLocal] Expected an array of URLs, but received a single string. Wrapping the string in an array.");
    urls = [urls]; // Convert single URL to array
  }

  const downloadedPaths = [];
  for (let url of urls) {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    const fileName = `remote_${hash}_${Date.now()}.mp4`;
    const dest = path.join(workDir, fileName);

    if (fs.existsSync(dest)) {
      console.log(`[downloadToLocal] Already downloaded: ${dest}`);
      downloadedPaths.push(dest);
      continue; // Skip if already downloaded
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
      downloadedPaths.push(dest);
    } catch (err) {
      console.error(`[downloadToLocal] Failed to download ${url}:`, err.message);
      downloadedPaths.push(null); // Push null if download fails
    }
  }

  return downloadedPaths;
}

// Fuzzy R2 Finder (Prioritize R2 first)
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
        .filter(obj => /\.(mp4|mov|webm|mkv)$/i.test(obj.Key)) // Filter video files only
        .map(obj => obj.Key); // Extract file names

      allKeys.push(...keys);
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    if (allKeys.length === 0) {
      console.warn(`[findBestVideoFromR2] No video keys found in R2 bucket.`);
      return null;
    }

    // Perform fuzzy search and return best match or fallback
    const names = allKeys.map(k => k.toLowerCase());
    const best = stringSimilarity.findBestMatch(mainSubject.toLowerCase(), names);
    if (best.bestMatch.rating > 0.1) {
      const key = allKeys[best.bestMatchIndex];
      const url = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`;
      console.log(`[findBestVideoFromR2] Fuzzy match: ${mainSubject} -> ${key}`);
      return url;
    }

    const fallbackKey = allKeys[Math.floor(Math.random() * allKeys.length)];
    const fallbackUrl = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${fallbackKey}`;
    console.log(`[findBestVideoFromR2] No good match, using fallback: ${fallbackKey}`);
    return fallbackUrl;
  } catch (err) {
    console.error("[findBestVideoFromR2] Error:", err);
    return null;
  }
}

// Pexels video search
async function getPexelsVideo(mainSubject) {
  try {
    const resp = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: mainSubject, per_page: 8 },
      timeout: 10000
    });

    const vids = resp.data.videos || [];
    if (vids.length) {
      vids.sort((a, b) => (a.height / a.width) - (b.height / b.width));
      const top = vids[0];
      const vf = top.video_files.find(f => (f.quality === "hd" || f.quality === "sd") && f.height >= 720 && f.width <= 900) || top.video_files[0];
      if (vf && vf.link) {
        console.log(`[getPexelsVideo] Found video: ${vf.link}`);
        return vf.link;
      }
    }
    console.warn(`[getPexelsVideo] No video found for ${mainSubject}`);
    return null;
  } catch (err) {
    console.error(`[getPexelsVideo] Error for ${mainSubject}:`, err);
    return null;
  }
}

// Fallback to local videos if needed
function getLocalFallback() {
  try {
    const files = fs.readdirSync(LOCAL_CLIP_DIR).filter(f => f.endsWith('.mp4'));
    if (files.length) {
      shuffleArray(files);
      const fallbackPath = path.join(LOCAL_CLIP_DIR, files[0]);
      console.log(`[getLocalFallback] Using local fallback: ${fallbackPath}`);
      return fallbackPath;
    }
  } catch (err) {
    console.warn("[getLocalFallback] Error:", err);
  }
  return null;
}

// Shuffle array utility
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Main function to pick a clip
async function pickClipFor(rawQuery, tempDir = TEMP_DIR, minScore = 0.1, mainSubject = '') {
  let subject = mainSubject || await extractMainSubject(rawQuery);
  if (!subject) subject = 'nature';

  let r2Url = await findBestVideoFromR2(subject);
  if (r2Url) {
    const localPath = await downloadToLocal(r2Url, tempDir);
    if (localPath) return { type: 'video', url: localPath, source: 'cloud_library' };
  }

  let pexelsUrl = await getPexelsVideo(subject);
  if (pexelsUrl) {
    const localPath = await downloadToLocal(pexelsUrl, tempDir);
    if (localPath) return { type: 'video', url: localPath, source: 'pexels' };
  }

  const localFallback = getLocalFallback();
  if (localFallback) return { type: 'video', url: localFallback, source: 'local_fallback' };

  console.error("[pickClipFor] No video found.");
  return null;
}

// Export for use
module.exports = { pickClipFor };
console.log('[Pexels Helper] Exported pickClipFor function.');
