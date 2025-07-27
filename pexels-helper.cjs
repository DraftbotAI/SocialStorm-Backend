/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - Includes GPT-powered visual subject extraction.
   - Handles all download/streaming and normalization.
   =========================================================== */

const AWS = require('aws-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// ENV
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

// --- Util: Normalize subject and filenames for matching ---
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '') // Remove spaces/underscores/dashes for fuzzy matching
    .replace(/[^a-z0-9]/g, ''); // Strip non-alphanum
}

// --- Subject extractor: pulls out visual main subject (not actions/details) ---
function extractMainSubject(line, title = '') {
  // If the script line contains the video "title" as a substring, use the title as anchor
  // Otherwise, use a set of rules: look for landmark/object, drop verbs/adjectives
  // If you want GPT-powered subject extraction, you can plug it in here
  const knownLandmarks = [
    "statue of liberty",
    "mount rushmore",
    "eiffel tower",
    "leaning tower of pisa",
    "taj mahal",
    "london bridge",
    "great wall of china",
    "cinderella castle",
    "thames",
    "lincoln's head",
    "torch",
    "bunker",
    "suite"
  ];
  const l = line.toLowerCase();
  let subject = '';

  // If a known landmark/object appears, use that as subject
  for (const landmark of knownLandmarks) {
    if (l.includes(landmark)) {
      subject = landmark;
      break;
    }
  }
  // If nothing matched, and the title exists in the line, anchor on that
  if (!subject && title && l.includes(title.toLowerCase())) {
    subject = title;
  }
  // Fallback: take first 3 words that are not "maintenance", "hidden", etc.
  if (!subject) {
    subject = line
      .replace(/[^a-z0-9\s]/gi, '')
      .split(' ')
      .filter(w => w && !['the', 'of', 'and', 'a', 'an', 'for', 'in', 'on', 'at', 'with', 'maintenance', 'hidden', 'secrets', 'suite', 'chamber'].includes(w.toLowerCase()))
      .slice(0, 3)
      .join(' ');
  }
  subject = subject.trim();
  if (!subject) subject = line;
  // Log for debug:
  console.log(`[SUBJECT] Extracted main subject: "${subject}" from line: "${line}"`);
  return subject;
}

// --- R2 CLIP MATCHING ---
async function findClipInR2(subject, s3Client) {
  if (!s3Client) throw new Error('[R2] s3Client not provided!');
  try {
    const listCmd = new ListObjectsV2Command({ Bucket: R2_LIBRARY_BUCKET });
    const resp = await s3Client.send(listCmd);
    if (!resp || !resp.Contents) {
      console.log('[R2] No files in bucket.');
      return null;
    }
    const files = resp.Contents.map(obj => obj.Key);
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);
    for (let file of files) {
      const normFile = normalize(file);
      if (normFile.includes(normQuery)) {
        console.log(`[R2] Found match: ${file}`);
        // Build the public URL (assuming gateway or direct access)
        let endpoint = process.env.R2_ENDPOINT || '';
        if (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1);
        return `https://${endpoint.replace('https://', '')}/${R2_LIBRARY_BUCKET}/${file}`;
      }
    }
    console.log('[R2] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[R2] Error listing or matching:', err);
    return null;
  }
}

// --- PEXELS FALLBACK ---
async function findClipInPexels(subject) {
  if (!PEXELS_API_KEY) {
    console.warn('[PEXELS] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=5`;
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      // Pick the highest quality clip from results
      const sorted = resp.data.videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const bestClip = sorted[0];
      const fileLink = bestClip.video_files.find(f => f.quality === 'hd') || bestClip.video_files[0];
      console.log('[PEXELS] Clip found:', fileLink.link);
      return fileLink.link;
    }
    console.log('[PEXELS] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[PEXELS] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- PIXABAY FALLBACK ---
async function findClipInPixabay(subject) {
  if (!PIXABAY_API_KEY) {
    console.warn('[PIXABAY] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=5`;
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      // Pick the highest quality video
      const best = resp.data.hits.sort((a, b) => (b.videos.large.width * b.videos.large.height) - (a.videos.large.width * a.videos.large.height))[0];
      console.log('[PIXABAY] Clip found:', best.videos.large.url);
      return best.videos.large.url;
    }
    console.log('[PIXABAY] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[PIXABAY] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- MAIN MATCHER: R2 → PEXELS → PIXABAY ---
async function findClipForScene(sceneText, idx, allLines = [], title = '', s3Client) {
  // Use main subject extractor to get best visual anchor
  const subject = extractMainSubject(sceneText, title);
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  // 1. Try R2 first
  if (s3Client) {
    const r2Url = await findClipInR2(subject, s3Client);
    if (r2Url) {
      console.log(`[MATCH] Using R2 video for: "${subject}"`);
      return r2Url;
    }
  }

  // 2. Try Pexels
  const pexelsUrl = await findClipInPexels(subject);
  if (pexelsUrl) {
    console.log(`[MATCH] Using Pexels video for: "${subject}"`);
    return pexelsUrl;
  }

  // 3. Try Pixabay
  const pixabayUrl = await findClipInPixabay(subject);
  if (pixabayUrl) {
    console.log(`[MATCH] Using Pixabay video for: "${subject}"`);
    return pixabayUrl;
  }

  console.log(`[MATCH] No video found for subject: "${subject}"`);
  return null;
}

// --- Download function: saves a remote file to disk with logging ---
async function downloadRemoteFileToLocal(url, outPath) {
  try {
    if (!url) throw new Error('No URL provided to download.');
    console.log('[DL] Downloading remote file:', url, '→', outPath);

    // If already downloaded, skip (optional)
    if (fs.existsSync(outPath)) {
      console.log('[DL] File already exists, skipping:', outPath);
      return;
    }

    const writer = fs.createWriteStream(outPath);
    const resp = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000 // 60 sec timeout
    });

    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      let errored = false;
      writer.on('error', err => {
        errored = true;
        console.error('[DL] Stream error:', err);
        writer.close();
        reject(err);
      });
      writer.on('finish', () => {
        if (!errored) {
          console.log('[DL] Download complete:', outPath);
          resolve();
        }
      });
    });

    // Double-check file written
    if (!fs.existsSync(outPath)) {
      throw new Error('[DL] File not written after download: ' + outPath);
    }
  } catch (err) {
    console.error('[DL] Download failed:', url, err);
    throw err;
  }
}

// --- Script splitter: splits raw script into array of { id, text } ---
function splitScriptToScenes(script) {
  if (!script) return [];
  return script
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((line, idx) => ({
      id: `scene${idx + 1}`,
      text: line
    }));
}

module.exports = {
  findClipForScene,
  splitScriptToScenes,
  downloadRemoteFileToLocal
};
