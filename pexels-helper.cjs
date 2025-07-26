console.log('============= [PEXELS HELPER LOADED | GOD TIER LOGGING READY ]=============');
console.log('[DEBUG] DEPLOY TEST', new Date());

/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   =========================================================== */
require('dotenv').config();
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');

console.log('[Pexels Helper] Loaded – HARD FILTERING + MAX RELEVANCE MODE.');

/* ========== DEBUG: ENV VARS ========== */
console.log('[DEBUG] ENV R2_LIBRARY_BUCKET:', process.env.R2_LIBRARY_BUCKET);
console.log('[DEBUG] ENV R2_ENDPOINT:', process.env.R2_ENDPOINT);
console.log('[DEBUG] ENV R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID);
console.log('[DEBUG] ENV R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? '***' : 'MISSING');

/* ===========================================================
   SECTION 2: CLOUDFLARE R2 CLIENT (VIDEO LIBRARY)
   =========================================================== */
const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

/* ===========================================================
   SECTION 3: MAIN CLIP MATCHING LOGIC (ALWAYS R2 FIRST)
   =========================================================== */
async function findBestClip(keywords, opts = {}) {
  const searchPhrase = Array.isArray(keywords) ? keywords.join(' ') : keywords;
  console.log(`[CLIP-MATCH] Requested keywords:`, searchPhrase);

  // === 1. SEARCH R2 (PRIMARY) ===
  try {
    console.log(`[R2] Searching R2 for: "${searchPhrase}"`);
    const bucket = process.env.R2_LIBRARY_BUCKET;
    if (!bucket) throw new Error("R2_LIBRARY_BUCKET not set");
    const list = await r2.send(new ListObjectsV2Command({ Bucket: bucket }));
    const objects = (list.Contents || []).map(o => o.Key);
    // God tier: log full object list size, don't dump all names
    console.log(`[R2] Found ${objects.length} total objects in bucket.`);
    // Filter for keywords in filename (case insensitive, underscores allowed)
    const norm = x => x.replace(/_/g, ' ').toLowerCase();
    const kw = norm(searchPhrase);
    let best = null;
    let bestScore = 0;
    for (const key of objects) {
      const score = scoreClipMatch(key, kw);
      if (score > bestScore) {
        best = key;
        bestScore = score;
      }
    }
    if (best && bestScore > 0) {
      console.log(`[R2] Best match: "${best}" (score: ${bestScore})`);
      // Return S3-style URL for use by the backend
      const r2Url = `${process.env.R2_ENDPOINT}/${bucket}/${best}`;
      return { source: "r2", url: r2Url, key: best, score: bestScore };
    }
    console.log(`[R2] No strong match in R2, will try Pexels...`);
  } catch (err) {
    console.error('[R2] Error searching R2:', err);
  }

  // === 2. SEARCH PEXELS (FALLBACK) ===
  try {
    const PEXELS_KEY = process.env.PEXELS_API_KEY;
    if (!PEXELS_KEY) throw new Error('PEXELS_API_KEY not set');
    const searchUrl = `https://api.pexels.com/videos/search?query=${encodeURIComponent(searchPhrase)}&per_page=5`;
    console.log(`[PEXELS] Querying: ${searchUrl}`);
    const res = await axios.get(searchUrl, { headers: { Authorization: PEXELS_KEY } });
    if (res.data && res.data.videos && res.data.videos.length > 0) {
      const v = res.data.videos[0];
      const videoUrl = v.video_files.find(f => f.quality === 'hd' && f.width >= 1280)?.link || v.video_files[0].link;
      console.log(`[PEXELS] Fallback match: ${videoUrl}`);
      return { source: "pexels", url: videoUrl, pexelsId: v.id };
    } else {
      console.log(`[PEXELS] No results found for: "${searchPhrase}"`);
    }
  } catch (err) {
    console.error('[PEXELS] Error:', err);
  }

  // === 3. SEARCH PIXABAY (FINAL FALLBACK) ===
  try {
    const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
    if (!PIXABAY_KEY) throw new Error('PIXABAY_API_KEY not set');
    const searchUrl = `https://pixabay.com/api/videos/?key=${PIXABAY_KEY}&q=${encodeURIComponent(searchPhrase)}&per_page=3`;
    console.log(`[PIXABAY] Querying: ${searchUrl}`);
    const res = await axios.get(searchUrl);
    if (res.data && res.data.hits && res.data.hits.length > 0) {
      const v = res.data.hits[0];
      // Pick the highest quality available
      const quality = v.videos['large'] || v.videos['medium'] || v.videos['small'];
      const pixabayUrl = quality.url;
      console.log(`[PIXABAY] Fallback match: ${pixabayUrl}`);
      return { source: "pixabay", url: pixabayUrl, pixabayId: v.id };
    } else {
      console.log(`[PIXABAY] No results for: "${searchPhrase}"`);
    }
  } catch (err) {
    console.error('[PIXABAY] Error:', err);
  }

  // === 4. TOTAL FAILURE ===
  console.warn(`[CLIP-MATCH] No clip found for "${searchPhrase}" from any source!`);
  return { source: "none", url: null };
}

// === Helper: Score how well a filename matches keywords (simple, tweak as needed) ===
function scoreClipMatch(filename, keywords) {
  // Remove extension, normalize, compare overlap of words
  const base = filename.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ').toLowerCase();
  const kwArr = keywords.split(/\s+/).filter(x => x.length > 0);
  let score = 0;
  for (const word of kwArr) {
    if (base.includes(word)) score += 2;
    else if (word.length > 4 && base.indexOf(word.slice(0, 4)) >= 0) score += 1;
  }
  return score;
}

/* ===========================================================
   SECTION 4: EXPORTS
   =========================================================== */
module.exports = {
  findBestClip
};



console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
