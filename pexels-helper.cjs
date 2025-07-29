/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - Improved visual subject extraction (no AI, just rules)
   - Handles all download/streaming and normalization.
   =========================================================== */

const AWS = require('aws-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// ENV
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

// --- IMPROVED Visual Subject Picker (Rule-Based, No AI) ---
function extractVisualSubject(line, title = '') {
  // Step 1: Prioritize famous landmarks or objects
  const famousSubjects = [
    "statue of liberty", "eiffel tower", "taj mahal", "mount rushmore", "great wall of china",
    "disney", "vatican", "empire state building", "sphinx", "london bridge", "lincoln memorial",
    "big ben", "colosseum", "golden gate bridge", "brooklyn bridge", "machu picchu",
    "trevi fountain", "niagara falls", "burj khalifa", "space needle", "grand canyon", "sydney opera house"
  ];

  let text = `${line} ${title || ''}`.toLowerCase();

  for (let name of famousSubjects) {
    if (text.includes(name)) return name;
  }

  // Step 2: Look for capitalized multi-word "proper noun" phrase (e.g., "Empire State Building")
  const proper = line.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  if (proper) return proper[1];

  // Step 3: Look for a single capitalized word (often a place/object)
  const capWord = line.match(/\b([A-Z][a-z]+)\b/);
  if (capWord) return capWord[1];

  // Step 4: Look for the last noun-like word (simple: last word longer than 3 letters)
  const words = line.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].length > 3 && /^[a-zA-Z]+$/.test(words[i])) {
      return words[i];
    }
  }

  // Step 5: Fallback to title or whole line
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

    // 1. Exact match (whole phrase)
    let best = null;
    for (let file of files) {
      const normFile = normalize(file);
      if (normFile.includes(normQuery)) {
        best = file;
        break;
      }
    }
    // 2. Partial match (all words must appear somewhere)
    if (!best) {
      const words = subject.split(/\s+/).map(normalize).filter(Boolean);
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
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      return url; // Always returns a string
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
      const sorted = resp.data.videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const bestClip = sorted[0];
      const fileLink = bestClip.video_files.find(f => f.quality === 'hd') || bestClip.video_files[0];
      if (fileLink && fileLink.link) {
        console.log('[PEXELS] Clip found:', fileLink.link);
        return fileLink.link; // ONLY the URL as a string
      }
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
      const best = resp.data.hits.sort((a, b) => (b.videos.large.width * b.videos.large.height) - (a.videos.large.width * a.videos.large.height))[0];
      if (best && best.videos && best.videos.large && best.videos.large.url) {
        console.log('[PIXABAY] Clip found:', best.videos.large.url);
        return best.videos.large.url; // ONLY the URL as a string
      }
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
  const subject = extractVisualSubject(sceneText, title || '');
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  // 1. Try R2 first
  if (s3Client) {
    const r2Url = await findClipInR2(subject, s3Client);
    if (typeof r2Url === 'string' && r2Url.startsWith('http')) return r2Url;
  }

  // 2. Try Pexels
  const pexelsUrl = await findClipInPexels(subject);
  if (typeof pexelsUrl === 'string' && pexelsUrl.startsWith('http')) return pexelsUrl;

  // 3. Try Pixabay
  const pixabayUrl = await findClipInPixabay(subject);
  if (typeof pixabayUrl === 'string' && pixabayUrl.startsWith('http')) return pixabayUrl;

  return null;
}

// --- Download function: saves a remote file to disk with logging ---
async function downloadRemoteFileToLocal(url, outPath) {
  try {
    if (!url) throw new Error('No URL provided to download.');
    console.log('[DL] Downloading remote file:', url, '→', outPath);

    if (fs.existsSync(outPath)) {
      console.log('[DL] File already exists, skipping:', outPath);
      return;
    }

    const writer = fs.createWriteStream(outPath);
    const resp = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000
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

    if (!fs.existsSync(outPath)) {
      throw new Error('[DL] File not written after download: ' + outPath);
    }
  } catch (err) {
    console.error('[DL] Download failed:', url, err);
    throw err;
  }
}

// --- Script splitter: splits raw script into array of { id, text } ----
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
