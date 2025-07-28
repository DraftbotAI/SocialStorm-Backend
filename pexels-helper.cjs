/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - Includes GPT-powered visual subject extraction (optional).
   - Handles all download/streaming and normalization.
   =========================================================== */

const AWS = require('aws-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// ENV
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT; // e.g., https://[ACCOUNT_ID].r2.cloudflarestorage.com
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

/* -- Visual Subject Extraction -- 
 * By default uses rule-based fallback; can upgrade to GPT-4.1.
 * Plug your GPT helper here if available.
 */
function extractVisualSubject(line, title = '') {
  // Replace with GPT-4.1-powered extraction for best results!
  // For now: Priority on famous landmarks; fallback to first proper noun.
  const famousLandmarks = [
    "statue of liberty", "eiffel tower", "taj mahal", "mount rushmore", "great wall of china",
    "disney", "vatican", "empire state building", "sphinx", "london bridge", "lincoln memorial",
    "big ben", "colosseum", "golden gate bridge", "brooklyn bridge", "machu picchu"
  ];

  let text = `${line} ${title || ''}`.toLowerCase();

  for (let name of famousLandmarks) {
    if (text.includes(name)) return name;
  }

  // Fallback: first capitalized group
  const match = line.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/);
  if (match) return match[1];

  // Fallback: use title or whole line
  if (title) return title;
  return line;
}

// --- Util: Normalize subject and filenames for matching ---
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '') // Remove spaces/underscores/dashes for fuzzy matching
    .replace(/[^a-z0-9]/g, ''); // Strip non-alphanum
}

// --- R2 CLIP MATCHING ---
async function listAllFilesInR2(s3Client, prefix = '') {
  let files = [];
  let continuationToken = undefined;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: R2_LIBRARY_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });
    const resp = await s3Client.send(cmd);
    if (resp && resp.Contents) {
      files.push(...resp.Contents.map(obj => obj.Key));
    }
    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);
  return files;
}

async function findClipInR2(subject, s3Client) {
  if (!s3Client) throw new Error('[R2] s3Client not provided!');
  try {
    const files = await listAllFilesInR2(s3Client, '');
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);

    // Match: look for subject keywords in file/folder names
    let best = null;
    for (let file of files) {
      const normFile = normalize(file);
      if (normFile.includes(normQuery)) {
        best = file;
        break;
      }
    }
    if (!best) {
      // Try loose partial match (split subject into words)
      const words = subject.split(/\s+/).map(normalize);
      for (let file of files) {
        const normFile = normalize(file);
        if (words.every(w => normFile.includes(w))) {
          best = file;
          break;
        }
      }
    }
    if (best) {
      console.log(`[R2] Found match: ${best}`);
      // Compose the direct public URL (assuming bucket public or via R2 gateway)
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      return url;
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
  // 1. Extract main visual subject
  const subject = extractVisualSubject(sceneText, title || '');
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  // 2. Try R2 first (deep search)
  if (s3Client) {
    const r2Url = await findClipInR2(subject, s3Client);
    if (r2Url) return r2Url;
  }

  // 3. Try Pexels
  const pexelsUrl = await findClipInPexels(subject);
  if (pexelsUrl) return pexelsUrl;

  // 4. Try Pixabay
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
