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

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_REGION = process.env.R2_REGION;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;

const s3 = new S3Client({
  region: R2_REGION,
  credentials: {
    accessKeyId: R2_ACCESS_KEY,
    secretAccessKey: R2_SECRET_KEY,
  },
  endpoint: `https://${R2_BUCKET}.${R2_REGION}.r2.cloudflarestorage.com`,
  forcePathStyle: false,
});

// === Split script into scene objects ===
function splitScriptToScenes(script) {
  console.log(`[SCENE SPLIT] Splitting script into scenes...`);
  if (!script || typeof script !== 'string') {
    console.error(`[SCENE SPLIT] Invalid script input.`);
    return [];
  }

  const lines = script
    .split(/\.\s+/)
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
  console.log(`[MATCH] Extracted keyword: "${query}"`);

  const r2 = await searchR2Library(query);
  if (r2) {
    console.log(`[MATCH] ✅ Matched from R2`);
    return r2;
  }

  const pexels = await fetchFromPexels(query);
  if (pexels) {
    console.log(`[MATCH] ✅ Matched from Pexels`);
    return pexels;
  }

  const pixabay = await fetchFromPixabay(query);
  if (pixabay) {
    console.log(`[MATCH] ✅ Matched from Pixabay`);
    return pixabay;
  }

  console.warn(`[MATCH] ❌ No match found for: "${query}"`);
  return null;
}

// === Simple keyword extractor ===
function extractVisualKeyword(text) {
  const stopwords = ['the', 'a', 'an', 'this', 'that', 'and', 'or', 'but', 'with', 'without', 'to', 'of', 'in', 'on', 'at'];
  const words = text.toLowerCase().split(/\s+/).filter(w => !stopwords.includes(w));
  const result = words.slice(0, 5).join(' ');
  console.log(`[KEYWORD] From input: "${text}" → "${result}"`);
  return result;
}

// === Search Cloudflare R2 for matching video ===
async function searchR2Library(keyword) {
  console.log(`[R2] Searching R2 for: "${keyword}"`);
  try {
    const command = new ListObjectsV2Command({ Bucket: R2_BUCKET });
    const data = await s3.send(command);
    const matches = data.Contents?.filter(obj =>
      obj.Key.toLowerCase().includes(keyword.toLowerCase())
    );

    if (matches && matches.length > 0) {
      const key = matches[0].Key;
      console.log(`[R2] ✅ Found match: ${key}`);
      return `https://${R2_BUCKET}.${R2_REGION}.r2.cloudflarestorage.com/${key}`;
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
  console.log(`[PEXELS] Searching Pexels for: "${query}"`);
  try {
    const res = await axios.get(`https://api.pexels.com/videos/search`, {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query, per_page: 1 }
    });
    const video = res.data.videos?.[0];
    if (video && video.video_files?.length) {
      const file = video.video_files.find(f => f.quality === 'sd' && f.width <= 720) || video.video_files[0];
      console.log(`[PEXELS] ✅ Clip found: ${file?.link}`);
      return file.link;
    } else {
      console.warn(`[PEXELS] ❌ No usable clip returned`);
    }
  } catch (err) {
    console.error(`[PEXELS ERROR] ${err.message}`);
  }
  return null;
}

// === Fetch from Pixabay ===
async function fetchFromPixabay(query) {
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
      const url = hits[0].videos.medium.url || hits[0].videos.small.url;
      console.log(`[PIXABAY] ✅ Clip found: ${url}`);
      return url;
    } else {
      console.warn(`[PIXABAY] ❌ No usable clip returned`);
    }
  } catch (err) {
    console.error(`[PIXABAY ERROR] ${err.message}`);
  }
  return null;
}

module.exports = {
  splitScriptToScenes,
  findClipForScene,
};



console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
