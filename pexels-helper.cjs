/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - If no video: Searches Pexels/Pixelbay for photo, returns with marker.
   - NEVER reuses photo or video in a single job.
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

async function findClipInR2(subject, s3Client, usedMedia) {
  if (!s3Client) throw new Error('[R2] s3Client not provided!');
  try {
    const files = await listAllFilesInR2(s3Client, '');
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);

    // 1. Exact match (whole phrase)
    let best = null;
    for (let file of files) {
      const normFile = normalize(file);
      if (!usedMedia.has(file) && normFile.includes(normQuery)) {
        best = file;
        break;
      }
    }
    // 2. Partial match (all words must appear somewhere)
    if (!best) {
      const words = subject.split(/\s+/).map(normalize).filter(Boolean);
      for (let file of files) {
        const normFile = normalize(file);
        if (!usedMedia.has(file) && words.every(w => normFile.includes(w))) {
          best = file;
          break;
        }
      }
    }
    if (best) {
      usedMedia.add(best);
      console.log(`[R2] Found match: ${best}`);
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      return { type: 'video', url };
    }
    console.log('[R2] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[R2] Error listing or matching:', err);
    return null;
  }
}

// --- PEXELS VIDEO FALLBACK ---
async function findClipInPexels(subject, usedMedia) {
  if (!PEXELS_API_KEY) {
    console.warn('[PEXELS] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=8`;
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      // Never return a used video (by original URL)
      const sorted = resp.data.videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      for (const vid of sorted) {
        const fileLink = vid.video_files.find(f => f.quality === 'hd') || vid.video_files[0];
        if (!usedMedia.has(fileLink.link)) {
          usedMedia.add(fileLink.link);
          console.log('[PEXELS] Clip found:', fileLink.link);
          return { type: 'video', url: fileLink.link };
        }
      }
    }
    console.log('[PEXELS] No video match found for:', subject);
    return null;
  } catch (err) {
    console.error('[PEXELS] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- PIXABAY VIDEO FALLBACK ---
async function findClipInPixabay(subject, usedMedia) {
  if (!PIXABAY_API_KEY) {
    console.warn('[PIXABAY] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=8`;
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      for (const hit of resp.data.hits) {
        const clipUrl = hit.videos.large.url;
        if (!usedMedia.has(clipUrl)) {
          usedMedia.add(clipUrl);
          console.log('[PIXABAY] Clip found:', clipUrl);
          return { type: 'video', url: clipUrl };
        }
      }
    }
    console.log('[PIXABAY] No video match found for:', subject);
    return null;
  } catch (err) {
    console.error('[PIXABAY] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- PEXELS PHOTO FALLBACK ---
async function findPhotoInPexels(subject, usedMedia) {
  if (!PEXELS_API_KEY) return null;
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=8`;
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.photos && resp.data.photos.length > 0) {
      for (const photo of resp.data.photos) {
        if (!usedMedia.has(photo.src.large2x)) {
          usedMedia.add(photo.src.large2x);
          console.log('[PEXELS PHOTO] Found:', photo.src.large2x);
          return { type: 'photo', url: photo.src.large2x };
        }
      }
    }
    console.log('[PEXELS PHOTO] No photo found for:', subject);
    return null;
  } catch (err) {
    console.error('[PEXELS PHOTO] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- PIXABAY PHOTO FALLBACK ---
async function findPhotoInPixabay(subject, usedMedia) {
  if (!PIXABAY_API_KEY) return null;
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=8`;
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      for (const hit of resp.data.hits) {
        if (!usedMedia.has(hit.largeImageURL)) {
          usedMedia.add(hit.largeImageURL);
          console.log('[PIXABAY PHOTO] Found:', hit.largeImageURL);
          return { type: 'photo', url: hit.largeImageURL };
        }
      }
    }
    console.log('[PIXABAY PHOTO] No photo found for:', subject);
    return null;
  } catch (err) {
    console.error('[PIXABAY PHOTO] Request failed:', err.response ? err.response.status : err);
    return null;
  }
}

// --- MAIN MATCHER: R2 → PEXELS → PIXABAY → PHOTO FALLBACKS ---
async function findClipForScene(sceneText, idx, allLines = [], title = '', s3Client, usedMedia = new Set()) {
  const subject = extractVisualSubject(sceneText, title || '');
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  // 1. Try R2 first
  if (s3Client) {
    const r2 = await findClipInR2(subject, s3Client, usedMedia);
    if (r2) return r2;
  }
  // 2. Try Pexels Video
  const pexels = await findClipInPexels(subject, usedMedia);
  if (pexels) return pexels;
  // 3. Try Pixabay Video
  const pixabay = await findClipInPixabay(subject, usedMedia);
  if (pixabay) return pixabay;
  // 4. Try Pexels Photo
  const pexelsPhoto = await findPhotoInPexels(subject, usedMedia);
  if (pexelsPhoto) return pexelsPhoto;
  // 5. Try Pixabay Photo
  const pixabayPhoto = await findPhotoInPixabay(subject, usedMedia);
  if (pixabayPhoto) return pixabayPhoto;

  // 6. Absolute last fallback: generic word photos (nature/people/etc), but NEVER repeat
  const genericWords = ['nature', 'people', 'background', 'travel', 'city', 'fun', 'animals', 'inspiration'];
  for (const word of genericWords) {
    const p1 = await findPhotoInPexels(word, usedMedia);
    if (p1) return p1;
    const p2 = await findPhotoInPixabay(word, usedMedia);
    if (p2) return p2;
  }

  // 7. Still nothing: log and return null (rare)
  console.error('[MATCH] ABSOLUTELY no media found for:', subject);
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
