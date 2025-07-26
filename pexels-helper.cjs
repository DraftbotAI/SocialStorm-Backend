// ==========================================
// Pexels + Scene Helper for SocialStormAI
// ------------------------------------------
// Priority: Cloudflare R2 → Pexels → Pixabay
// Functions:
// - splitScriptToScenes(script)
// - findClipForScene(sceneText)
// ==========================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

// === ENV & BUCKET SETUP ===
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

// Prefer explicit library bucket/env, fallback if missing
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || process.env.R2_BUCKET || 'socialstorm-library';
const R2_REGION = 'auto'; // For Cloudflare R2 always 'auto'
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;

// Env sanity warnings
if (!PEXELS_API_KEY) console.warn('[PEXELS HELPER] WARNING: No PEXELS_API_KEY set!');
if (!PIXABAY_API_KEY) console.warn('[PEXELS HELPER] WARNING: No PIXABAY_API_KEY set!');
if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[PEXELS HELPER] WARNING: Missing Cloudflare R2 credentials or endpoint!');
}

// ---- S3Client for R2 library ----
const s3 = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// === Split script into scene objects ===
function splitScriptToScenes(script) {
  console.log(`[SCENE SPLIT] Splitting script into scenes...`);
  if (!script || typeof script !== 'string') {
    console.error(`[SCENE SPLIT] Invalid script input.`);
    return [];
  }
  // Split on period, but keep lines tight (handles edge cases)
  const lines = script
    .split(/\.\s+|\.$/g)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const scenes = lines.map((text, index) => ({
    id: `scene${index + 1}`,
    text,
  }));

  console.log(`[SCENE SPLIT] Split into ${scenes.length} scenes.`);
  return scenes;
}

// === Main scene matching function ===
async function findClipForScene(sceneText) {
  console.log(`[MATCH] Starting match for scene: "${sceneText}"`);

  const query = extractVisualKeyword(sceneText);
  if (!query) {
    console.warn(`[MATCH] No keyword could be extracted from: "${sceneText}"`);
    return null;
  }
  console.log(`[MATCH] Extracted keyword: "${query}"`);

  // 1. R2 Library (main source)
  try {
    const r2 = await searchR2Library(query);
    if (r2) {
      console.log(`[MATCH] ✅ Matched from R2`);
      return r2;
    }
  } catch (err) {
    console.error(`[R2 ERROR] Exception: ${err.message}`);
  }

  // 2. Pexels fallback
  try {
    const pexels = await fetchFromPexels(query);
    if (pexels) {
      console.log(`[MATCH] ✅ Matched from Pexels`);
      return pexels;
    }
  } catch (err) {
    console.error(`[PEXELS ERROR] Exception: ${err.message}`);
  }

  // 3. Pixabay fallback
  try {
    const pixabay = await fetchFromPixabay(query);
    if (pixabay) {
      console.log(`[MATCH] ✅ Matched from Pixabay`);
      return pixabay;
    }
  } catch (err) {
    console.error(`[PIXABAY ERROR] Exception: ${err.message}`);
  }

  console.warn(`[MATCH] ❌ No match found for: "${query}"`);
  return null;
}

// === Smarter keyword extractor ===
function extractVisualKeyword(text) {
  const stopwords = [
    'the', 'a', 'an', 'this', 'that', 'and', 'or', 'but', 'with', 'without',
    'to', 'of', 'in', 'on', 'at', 'for', 'from', 'by', 'is', 'are', 'it', 'as', 'was'
  ];
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // remove punctuation
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.includes(w));

  // Prioritize first N meaningful words
  let result = words.slice(0, 5).join(' ');
  if (!result && words.length > 0) result = words[0];
  console.log(`[KEYWORD] From input: "${text}" → "${result}"`);
  return result;
}

// === Search Cloudflare R2 for matching video ===
async function searchR2Library(keyword) {
  console.log(`[R2] Searching R2 for: "${keyword}"`);
  try {
    const command = new ListObjectsV2Command({ Bucket: R2_LIBRARY_BUCKET });
    const data = await s3.send(command);

    if (!data.Contents || !Array.isArray(data.Contents)) {
      console.warn('[R2] No files found in library bucket.');
      return null;
    }

    // Sort by best match (first that contains keyword, favoring start of filename)
    const matches = data.Contents
      .map(obj => obj.Key)
      .filter(key => key && key.toLowerCase().includes(keyword.toLowerCase()))
      .sort((a, b) => a.toLowerCase().indexOf(keyword) - b.toLowerCase().indexOf(keyword));

    if (matches.length > 0) {
      const key = matches[0];
      const r2Url = `${R2_ENDPOINT.replace(/\/$/, '')}/${R2_LIBRARY_BUCKET}/${key}`;
      console.log(`[R2] ✅ Found match: ${key} | Full URL: ${r2Url}`);
      return r2Url;
    } else {
      console.warn(`[R2] ❌ No match found for: "${keyword}"`);
    }
  } catch (err) {
    console.error(`[R2 ERROR] Failed to search R2: ${err.message}`);
  }
  return null;
}

// === Fetch from Pexels ===
async function fetchFromPexels(query) {
  if (!PEXELS_API_KEY) {
    console.warn(`[PEXELS] No API key set.`);
    return null;
  }
  console.log(`[PEXELS] Searching Pexels for: "${query}"`);
  try {
    const res = await axios.get(`https://api.pexels.com/videos/search`, {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query, per_page: 1 }
    });
    const video = res.data.videos?.[0];
    if (video && video.video_files?.length) {
      // Prefer SD or lower, fallback to first file
      const file = video.video_files.find(f => f.quality === 'sd' && f.width <= 720) || video.video_files[0];
      if (file && file.link) {
        console.log(`[PEXELS] ✅ Clip found: ${file.link}`);
        return file.link;
      }
    }
    console.warn(`[PEXELS] ❌ No usable clip returned`);
  } catch (err) {
    console.error(`[PEXELS ERROR] ${err.message}`);
  }
  return null;
}

// === Fetch from Pixabay ===
async function fetchFromPixabay(query) {
  if (!PIXABAY_API_KEY) {
    console.warn(`[PIXABAY] No API key set.`);
    return null;
  }
  console.log(`[PIXABAY] Searching Pixabay for: "${query}"`);
  try {
    const res = await axios.get(`https://pixabay.com/api/videos/`, {
      params: {
        key: PIXABAY_API_KEY,
        q: query,
        safesearch: true,
        per_page: 3
      }
    });
    const hits = res.data.hits;
    if (hits && hits.length > 0) {
      // Try medium, fallback to small
      const url = hits[0].videos?.medium?.url || hits[0].videos?.small?.url;
      if (url) {
        console.log(`[PIXABAY] ✅ Clip found: ${url}`);
        return url;
      }
    }
    console.warn(`[PIXABAY] ❌ No usable clip returned`);
  } catch (err) {
    console.error(`[PIXABAY ERROR] ${err.message}`);
  }
  return null;
}

// Export for server
module.exports = {
  splitScriptToScenes,
  findClipForScene,
};

console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
