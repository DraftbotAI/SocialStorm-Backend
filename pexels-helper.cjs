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

// Import OpenAI client from main server context (if needed)
// const { openai } = require('./server'); // If you need to call GPT here

// --- Util: Normalize subject and filenames for matching ---
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '') // Remove spaces/underscores/dashes for fuzzy matching
    .replace(/[^a-z0-9]/g, ''); // Strip non-alphanum
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
        // Presume direct S3 URL: you may need to construct a presigned URL or use your gateway
        return `https://${process.env.R2_ENDPOINT.replace('https://', '')}/${R2_LIBRARY_BUCKET}/${file}`;
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
  // Extract true visual subject if using GPT-powered subject matcher.
  const subject = sceneText; // Replace with GPT logic if you wish
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  // 1. Try R2 first
  if (s3Client) {
    const r2Url = await findClipInR2(subject, s3Client);
    if (r2Url) return r2Url;
  }

  // 2. Try Pexels
  const pexelsUrl = await findClipInPexels(subject);
  if (pexelsUrl) return pexelsUrl;

  // 3. Try Pixabay
  const pixabayUrl = await findClipInPixabay(subject);
  if (pixabayUrl) return pixabayUrl;

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
