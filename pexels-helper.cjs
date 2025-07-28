/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - Includes refined visual subject extraction.
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

// --- Smarter Visual Subject Extraction ---
// Returns the most visual, matchable subject (landmark/object/thing)
function extractVisualSubject(line, title = '') {
  const famousLandmarks = [
    "statue of liberty", "eiffel tower", "taj mahal", "mount rushmore", "great wall of china",
    "disney", "vatican", "empire state building", "sphinx", "london bridge", "lincoln memorial",
    "big ben", "colosseum", "golden gate bridge", "brooklyn bridge", "machu picchu"
  ];
  let text = `${line} ${title || ''}`.toLowerCase();

  // 1. Landmark override
  for (let name of famousLandmarks) {
    if (text.includes(name)) return name;
  }

  // 2. Try: proper noun phrases / 'the X' (e.g. 'the fountain', 'Central Park')
  const nounPhrase = line.match(/\b(the|a|an)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i);
  if (nounPhrase) return nounPhrase[2];

  // 3. Try: longest capitalized word group in the line
  const caps = [...line.matchAll(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g)];
  if (caps.length > 0) {
    // Use the longest capitalized group (so 'Trevi Fountain' > 'Rome')
    const best = caps.map(m => m[1]).sort((a, b) => b.length - a.length)[0];
    if (best && best.length > 2) return best;
  }

  // 4. Try: most "noun-like" word (last fallback, prefer after 'of' or 'at')
  const ofMatch = line.match(/of ([A-Za-z ]+)/i);
  if (ofMatch) {
    let guess = ofMatch[1].trim();
    if (guess.split(' ').length <= 5) return guess;
  }
  const atMatch = line.match(/at ([A-Za-z ]+)/i);
  if (atMatch) {
    let guess = atMatch[1].trim();
    if (guess.split(' ').length <= 5) return guess;
  }

  // 5. Title fallback if no strong noun found
  if (title && title.length > 2) return title;
  // 6. Last fallback: first two words
  return line.split(/\s+/).slice(0, 3).join(' ');
}

// --- Normalize subject and filenames for fuzzy matching ---
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// --- List all objects in R2 (recursive/all subfolders) ---
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

// --- R2 Matching with Smarter Logic ---
async function findClipInR2(subject, s3Client) {
  if (!s3Client) throw new Error('[R2] s3Client not provided!');
  try {
    const files = await listAllFilesInR2(s3Client, '');
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);

    // 1. Strong: full exact match
    let best = files.find(file => normalize(file).includes(normQuery));
    if (best) {
      console.log(`[R2] Exact match: ${best}`);
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      return url;
    }

    // 2. Try: all subject words must appear (any order)
    const words = subject.split(/\s+/).map(normalize).filter(Boolean);
    for (let file of files) {
      const normFile = normalize(file);
      if (words.length > 1 && words.every(w => normFile.includes(w))) {
        console.log(`[R2] Combo word match: ${file}`);
        let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
        url += `${R2_LIBRARY_BUCKET}/${file}`;
        return url;
      }
    }

    // 3. Partial: any big word (min 5 chars)
    const bigWords = words.filter(w => w.length > 4);
    for (let file of files) {
      const normFile = normalize(file);
      if (bigWords.some(w => normFile.includes(w))) {
        console.log(`[R2] Partial big-word match: ${file}`);
        let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
        url += `${R2_LIBRARY_BUCKET}/${file}`;
        return url;
      }
    }

    console.log('[R2] No strong match found for:', subject);
    return null;
  } catch (err) {
    console.error('[R2] Error listing or matching:', err);
    return null;
  }
}

// --- PEXELS Fallback (HD-First, Top-5 Results) ---
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
      for (let vid of sorted) {
        const fileLink = vid.video_files.find(f => f.quality === 'hd') || vid.video_files[0];
        if (fileLink && fileLink.link) {
          console.log('[PEXELS] Clip found:', fileLink.link);
          return fileLink.link;
        }
      }
    }
    console.log('[PEXELS] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[PEXELS] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- PIXABAY Fallback (HD-First, Top-5 Results) ---
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
      const sorted = resp.data.hits.sort((a, b) => (b.videos.large.width * b.videos.large.height) - (a.videos.large.width * a.videos.large.height));
      for (let best of sorted) {
        const url = best.videos.large.url;
        if (url) {
          console.log('[PIXABAY] Clip found:', url);
          return url;
        }
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

  // 1. Try R2 first (deep match)
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

  // 4. Nothing found, fallback to title or generic
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
