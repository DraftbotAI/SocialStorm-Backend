/* ===========================================================
   PEXELS HELPER – SMART VIDEO CLIP MATCHING
   -----------------------------------------------------------
   - Tries Cloudflare R2 (socialstorm-library) first
   - Falls back to Pexels API
   - Final fallback to Pixabay API
   - Avoids duplicate clips, logs each step
   =========================================================== */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// ========== R2 CONFIG ==========
const r2 = new AWS.S3({
  endpoint: 'https://'+process.env.R2_ENDPOINT,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'auto',
  signatureVersion: 'v4'
});
const R2_BUCKET = process.env.R2_BUCKET || 'socialstorm-library';

// ========== PEXELS + PIXABAY CONFIG ==========
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const usedUrls = new Set(); // prevents duplicates per video

// ========== MAIN EXPORT ==========
async function findClipForPhrase(phrase, topic = '') {
  const keywords = phrase.trim().toLowerCase().split(/\s+/).slice(0, 5).join(' ');
  console.log(`[CLIP] Searching for: "${keywords}" (topic: "${topic}")`);

  // === Try Cloudflare R2 ===
  try {
    const r2Match = await searchR2(keywords);
    if (r2Match) return r2Match;
  } catch (err) {
    console.warn('[R2] Error during search:', err.message);
  }

  // === Try Pexels ===
  try {
    const pexelsMatch = await searchPexels(keywords);
    if (pexelsMatch) return pexelsMatch;
  } catch (err) {
    console.warn('[PEXELS] Error during search:', err.message);
  }

  // === Try Pixabay ===
  try {
    const pixabayMatch = await searchPixabay(keywords);
    if (pixabayMatch) return pixabayMatch;
  } catch (err) {
    console.warn('[PIXABAY] Error during search:', err.message);
  }

  console.warn('[CLIP] No match found for:', keywords);
  return null;
}

// ========== R2 SEARCH ==========
async function searchR2(query) {
  console.log(`[R2] Searching in bucket for: ${query}`);
  const prefix = ''; // Optional path inside bucket
  const list = await r2
    .listObjectsV2({ Bucket: R2_BUCKET, Prefix: prefix })
    .promise();

  const lowerQuery = query.toLowerCase();
  const match = list.Contents.find(obj => {
    const filename = obj.Key.toLowerCase();
    return (
      filename.includes(lowerQuery) &&
      !usedUrls.has(filename) &&
      (filename.endsWith('.mp4') || filename.endsWith('.mov'))
    );
  });

  if (match) {
    const url = `https://${process.env.R2_PUBLIC_DOMAIN}/${match.Key}`;
    usedUrls.add(match.Key);
    console.log(`[R2] Match found: ${match.Key}`);
    return url;
  }

  return null;
}

// ========== PEXELS SEARCH ==========
async function searchPexels(query) {
  console.log(`[PEXELS] Searching for: ${query}`);
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10`;
  const headers = { Authorization: PEXELS_API_KEY };
  const res = await axios.get(url, { headers });

  if (!res.data || !res.data.videos) return null;

  for (const video of res.data.videos) {
    const clip = video.video_files.find(
      v => v.quality === 'sd' && v.file_type === 'video/mp4'
    );
    if (clip && !usedUrls.has(clip.link)) {
      usedUrls.add(clip.link);
      console.log(`[PEXELS] Match found: ${clip.link}`);
      return clip.link;
    }
  }

  return null;
}

// ========== PIXABAY SEARCH ==========
async function searchPixabay(query) {
  console.log(`[PIXABAY] Searching for: ${query}`);
  const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&per_page=10`;
  const res = await axios.get(url);

  if (!res.data || !res.data.hits) return null;

  for (const hit of res.data.hits) {
    const clip = hit.videos.medium.url;
    if (clip && !usedUrls.has(clip)) {
      usedUrls.add(clip);
      console.log(`[PIXABAY] Match found: ${clip}`);
      return clip;
    }
  }

  return null;
}

module.exports = { findClipForPhrase };



console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
