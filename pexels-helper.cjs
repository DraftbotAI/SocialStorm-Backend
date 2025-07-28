/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - GPT-powered visual subject extraction (async, bulletproof).
   - Avoids duplicate clips within a video job.
   - Handles all download/streaming and normalization.
   =========================================================== */

const AWS = require('aws-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// ✅ FIXED: OpenAI Import for CommonJS (.cjs) compatibility
const OpenAI = require("openai");
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ENV
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT; // e.g., https://[ACCOUNT_ID].r2.cloudflarestorage.com
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

// --- GPT-4 Scene Visual Subject Extraction ---
async function extractVisualSubject(line, scriptTopic = '') {
  const prompt = `Extract the main visual subject of this sentence for a video search. Return ONLY the real-world thing (object, person, landmark, or place), not generic words, not a verb, not a question, not a connector. If the sentence is abstract, return the most visually matchable noun or, if none exists, return the main script topic.

Sentence: "${line}"
Script Topic: "${scriptTopic}"

Return just the one best subject for visuals. Example answers: "Eiffel Tower", "Statue of Liberty", "Qutb Minar", "Taj Mahal", "Trevi Fountain", "Hidden chamber", "Disney World’s Cinderella Castle", "Mount Rushmore".

Strictly respond with only the subject, never the whole sentence or anything else.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 16
    });
    let subject = response.choices[0].message.content.trim();
    if (!subject || subject.length < 2 || ['what', 'and', 'but', 'the', 'this'].includes(subject.toLowerCase())) {
      subject = scriptTopic || 'history';
    }
    console.log(`[SUBJECT][GPT] For: "${line}" | Extracted subject: "${subject}"`);
    return subject;
  } catch (err) {
    console.error('[GPT SUBJECT ERROR]', err?.response?.data || err);
    return scriptTopic || (line.split(' ').slice(0, 2).join(' '));
  }
}

// --- Util: Normalize subject and filenames for matching ---
function normalize(str) {
  return String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
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

async function findClipInR2(subject, s3Client, usedClips = []) {
  if (!s3Client) throw new Error('[R2] s3Client not provided!');
  try {
    const files = await listAllFilesInR2(s3Client, '');
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);

    let best = null;
    for (let file of files) {
      const normFile = normalize(file);
      if (normFile.includes(normQuery) && !usedClips.includes(file)) {
        best = file;
        break;
      }
    }
    if (!best) {
      const words = subject.split(/\s+/).map(normalize);
      for (let file of files) {
        const normFile = normalize(file);
        if (words.every(w => normFile.includes(w)) && !usedClips.includes(file)) {
          best = file;
          break;
        }
      }
    }
    if (best) {
      console.log(`[R2] Found match: ${best}`);
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      return { url, file };
    }
    console.log('[R2] No match found for:', subject);
    return null;
  } catch (err) {
    console.error('[R2] Error listing or matching:', err);
    return null;
  }
}

// --- PEXELS FALLBACK ---
async function findClipInPexels(subject, usedClips = []) {
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
      for (let bestClip of sorted) {
        const fileLink = bestClip.video_files.find(f => f.quality === 'hd') || bestClip.video_files[0];
        if (fileLink && !usedClips.includes(fileLink.link)) {
          console.log('[PEXELS] Clip found:', fileLink.link);
          return { url: fileLink.link, file: fileLink.link };
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

// --- PIXABAY FALLBACK ---
async function findClipInPixabay(subject, usedClips = []) {
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
        const clipUrl = best.videos.large.url;
        if (clipUrl && !usedClips.includes(clipUrl)) {
          console.log('[PIXABAY] Clip found:', clipUrl);
          return { url: clipUrl, file: clipUrl };
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

// --- MAIN MATCHER ---
async function findClipForScene(sceneText, idx, allLines = [], title = '', s3Client, usedClips = []) {
  const subject = await extractVisualSubject(sceneText, title || '');
  console.log(`[MATCH] Scene ${idx + 1} subject: "${subject}"`);

  if (s3Client) {
    const r2 = await findClipInR2(subject, s3Client, usedClips);
    if (r2) return r2;
  }

  const pexels = await findClipInPexels(subject, usedClips);
  if (pexels) return pexels;

  const pixabay = await findClipInPixabay(subject, usedClips);
  if (pixabay) return pixabay;

  return null;
}

// --- Download Remote File ---
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

// --- Script Splitter ---
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
