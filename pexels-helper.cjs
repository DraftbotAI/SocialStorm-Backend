/* ===========================================================
   PEXELS HELPER MODULE – SocialStormAI
   -----------------------------------------------------------
   - Searches Cloudflare R2 (S3 API), then Pexels, then Pixabay for matching clips
   - Returns best video file path or direct URL for scene/keyword
   - Bulletproof file checks, deduplication, and error handling
   =========================================================== */

require('dotenv').config();
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');



/* ===========================================================
   SECTION 1: S3/R2 CLIENT SETUP
   =========================================================== */

const R2_BUCKET = process.env.R2_LIBRARY_BUCKET || process.env.AWS_BUCKET_NAME || "socialstorm-library";
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});


/* ===========================================================
   SECTION 2: PEXELS & PIXABAY CONFIG
   =========================================================== */

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const PEXELS_API_URL = 'https://api.pexels.com/videos/search';
const PIXABAY_API_URL = 'https://pixabay.com/api/videos/';


/* ===========================================================
   SECTION 3: UTILITY – DEDUPLICATION + FILE CHECKS
   =========================================================== */

// Deduplicate by URL or file key (case-insensitive)
function dedupeClips(clips) {
  const seen = new Set();
  return clips.filter(c => {
    const id = (c.key || c.url || c.file || '').toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Confirm a file path is a real file (not directory)
function isRealFile(fp) {
  try {
    return fs.existsSync(fp) && fs.statSync(fp).isFile();
  } catch (e) {
    return false;
  }
}


/* ===========================================================
   SECTION 4: R2 LIBRARY SEARCH
   =========================================================== */

async function searchR2Library(keyword) {
  if (!keyword || !R2_BUCKET || !s3Client) return [];
  let matches = [];
  try {
    // List all files with keyword in the key (filename)
    const cmd = new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: '',
    });
    const resp = await s3Client.send(cmd);
    if (resp && resp.Contents && Array.isArray(resp.Contents)) {
      matches = resp.Contents
        .filter(obj =>
          obj.Key &&
          obj.Key.toLowerCase().includes(keyword.toLowerCase()) &&
          /\.(mp4|mov|webm|mkv)$/i.test(obj.Key)
        )
        .map(obj => ({
          source: "r2",
          key: obj.Key,
          url: `${R2_ENDPOINT}/${R2_BUCKET}/${obj.Key}`,
        }));
    }
  } catch (err) {
    console.error('[PEXELS HELPER][R2] Error:', err);
  }
  return matches;
}


/* ===========================================================
   SECTION 5: PEXELS SEARCH
   =========================================================== */

async function searchPexels(keyword) {
  if (!PEXELS_API_KEY || !keyword) return [];
  try {
    const resp = await axios.get(PEXELS_API_URL, {
      headers: { Authorization: PEXELS_API_KEY },
      params: {
        query: keyword,
        per_page: 10,
        orientation: "landscape"
      }
    });
    if (resp.data && Array.isArray(resp.data.videos)) {
      return resp.data.videos.map(clip => ({
        source: "pexels",
        url: clip.video_files && clip.video_files[0] && clip.video_files[0].link,
        id: clip.id,
        width: clip.width,
        height: clip.height,
        duration: clip.duration
      })).filter(c => c.url);
    }
  } catch (err) {
    console.error('[PEXELS HELPER][PEXELS] Error:', err);
  }
  return [];
}


/* ===========================================================
   SECTION 6: PIXABAY SEARCH
   =========================================================== */

async function searchPixabay(keyword) {
  if (!PIXABAY_API_KEY || !keyword) return [];
  try {
    const resp = await axios.get(PIXABAY_API_URL, {
      params: {
        key: PIXABAY_API_KEY,
        q: keyword,
        per_page: 10,
        safesearch: true,
        video_type: "film"
      }
    });
    if (resp.data && Array.isArray(resp.data.hits)) {
      return resp.data.hits.map(clip => {
        const url =
          clip.videos.medium?.url ||
          clip.videos.large?.url ||
          clip.videos.tiny?.url;
        return {
          source: "pixabay",
          url,
          id: clip.id,
          width: clip.videos.medium?.width || 0,
          height: clip.videos.medium?.height || 0,
          duration: clip.duration || 0
        };
      }).filter(c => c.url);
    }
  } catch (err) {
    console.error('[PEXELS HELPER][PIXABAY] Error:', err);
  }
  return [];
}


/* ===========================================================
   SECTION 7: MASTER MATCH FUNCTION
   =========================================================== */

async function findBestClip(keyword) {
  let allClips = [];

  // 1. Try R2 library first
  const r2Clips = await searchR2Library(keyword);
  if (r2Clips.length > 0) {
    allClips = allClips.concat(r2Clips);
  }

  // 2. If not enough, search Pexels
  if (allClips.length < 3) {
    const pexelsClips = await searchPexels(keyword);
    if (pexelsClips.length > 0) {
      allClips = allClips.concat(pexelsClips);
    }
  }

  // 3. If still not enough, search Pixabay
  if (allClips.length < 3) {
    const pixabayClips = await searchPixabay(keyword);
    if (pixabayClips.length > 0) {
      allClips = allClips.concat(pixabayClips);
    }
  }

  // Deduplicate and return
  const uniqueClips = dedupeClips(allClips);

  // Sort: Prefer R2, then Pexels, then Pixabay, by closest duration to 8s
  uniqueClips.sort((a, b) => {
    if (a.source !== b.source) {
      if (a.source === "r2") return -1;
      if (b.source === "r2") return 1;
      if (a.source === "pexels") return -1;
      if (b.source === "pexels") return 1;
    }
    const ad = Math.abs((a.duration || 8) - 8);
    const bd = Math.abs((b.duration || 8) - 8);
    return ad - bd;
  });

  // Return first/best match or empty array
  return uniqueClips[0] || null;
}


/* ===========================================================
   SECTION 8: EXPORTS
   =========================================================== */

module.exports = {
  findBestClip,
  searchR2Library,
  searchPexels,
  searchPixabay
};

