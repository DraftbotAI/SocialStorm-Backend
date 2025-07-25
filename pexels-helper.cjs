// ============== [PEXELS HELPER LOADED AT RUNTIME] ==============
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
const ffmpeg = require('fluent-ffmpeg');
console.log('[Pexels Helper] Loaded – HARD FILTERING + MAX RELEVANCE MODE.');

/* ========== DEBUG: ENV VARS ========== */
console.log('[DEBUG] ENV R2_LIBRARY_BUCKET:', process.env.R2_LIBRARY_BUCKET);
console.log('[DEBUG] ENV R2_ENDPOINT:', process.env.R2_ENDPOINT);
console.log('[DEBUG] ENV R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID);
console.log('[DEBUG] ENV R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? '***' : 'MISSING');

/* ===========================================================
   SECTION 2: CLOUDFLARE R2 SDK CLIENT
   =========================================================== */
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

/* ===========================================================
   SECTION 3: GPT SUBJECT EXTRACTOR (PLACEHOLDER)
   =========================================================== */
// Add your GPT subject extraction logic here if needed.

/* ===========================================================
   SECTION 4: VIDEO CLIP SEARCH & MATCH LOGIC
   =========================================================== */

async function searchClipsR2(matchPhrase) {
  try {
    const params = {
      Bucket: process.env.R2_LIBRARY_BUCKET,
      Prefix: '',
      MaxKeys: 1000
    };
    const data = await s3.send(new ListObjectsV2Command(params));
    const items = data.Contents || [];
    let bestMatch = null;
    let bestScore = -1;
    let match = matchPhrase.toLowerCase();
    items.forEach(obj => {
      const fname = obj.Key.toLowerCase();
      if (fname.includes(match) && fname.endsWith('.mp4')) {
        if (fname === match + '.mp4') {
          bestMatch = obj.Key;
          bestScore = 9999;
        } else if (bestScore < 9999) {
          bestMatch = obj.Key;
          bestScore = 1;
        }
      }
    });
    if (bestMatch) {
      console.log(`[R2] Best match for "${matchPhrase}":`, bestMatch);
      return { source: 'r2', key: bestMatch };
    }
    return null;
  } catch (err) {
    console.error('[R2] Error searching R2:', err);
    return null;
  }
}

async function getPexelsClip(matchPhrase) {
  try {
    const resp = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: matchPhrase, per_page: 3 }
    });
    if (resp.data.videos && resp.data.videos.length > 0) {
      const first = resp.data.videos[0];
      const url = first.video_files?.find(f => f.quality === 'hd' && f.width <= 1280)?.link
        || first.video_files?.find(f => f.width <= 1280)?.link
        || first.video_files?.[0]?.link;
      if (url) {
        return { source: 'pexels', url, id: first.id };
      }
    }
    return null;
  } catch (err) {
    console.error('[PEXELS] Error:', err.response?.data || err);
    return null;
  }
}

async function getPixabayClip(matchPhrase) {
  try {
    const resp = await axios.get('https://pixabay.com/api/videos/', {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: matchPhrase,
        per_page: 3,
        safesearch: true,
        editors_choice: true
      }
    });
    if (resp.data.hits && resp.data.hits.length > 0) {
      const first = resp.data.hits[0];
      const url = first.videos.medium.url || first.videos.tiny.url;
      if (url) {
        return { source: 'pixabay', url, id: first.id };
      }
    }
    return null;
  } catch (err) {
    console.error('[PIXABAY] Error:', err.response?.data || err);
    return null;
  }
}

async function getBestClip(matchPhrase) {
  let res = await searchClipsR2(matchPhrase);
  if (res) return res;
  res = await getPexelsClip(matchPhrase);
  if (res) return res;
  res = await getPixabayClip(matchPhrase);
  if (res) return res;
  return null;
}

/* ===========================================================
   SECTION 5: CLEANUP JOB FUNCTION (FULL EXPORT)
   =========================================================== */
function cleanupJob(jobId) {
  // Implement actual cleanup logic here if needed (remove temp files, etc)
  console.log(`[CLEANUP] cleanupJob called for jobId: ${jobId}`);
  // Currently this is a safe no-op to prevent crashes
}

/* ===========================================================
   SECTION 6: EXPORTS
   =========================================================== */
module.exports = {
  getBestClip,
  searchClips: searchClipsR2,
  getPexelsClip,
  getPixabayClip,
  cleanupJob
};


console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
