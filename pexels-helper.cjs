// ==========================================
// Pexels + Scene Helper for SocialStormAI (GPT-Subject + Best Match)
// ------------------------------------------
// Priority: R2, Pexels, Pixabay (all sources scored, best returned)
// - GPT-4.1-powered main subject extractor per scene
// - Scene 1+2 both use subject from Scene 2 (anchor)
// - Returns best-matching clip across all sources
// ==========================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { OpenAI } = require('openai');

// === ENV & BUCKET SETUP ===
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || process.env.R2_BUCKET || 'socialstorm-library';
const R2_REGION = 'auto';
const R2_ENDPOINT = process.env.R2_ENDPOINT || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY;

if (!PEXELS_API_KEY) console.warn('[PEXELS HELPER] WARNING: No PEXELS_API_KEY set!');
if (!PIXABAY_API_KEY) console.warn('[PEXELS HELPER] WARNING: No PIXABAY_API_KEY set!');
if (!OPENAI_API_KEY) console.warn('[PEXELS HELPER] WARNING: No OPENAI_API_KEY set!');
if (!R2_LIBRARY_BUCKET || !R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.warn('[PEXELS HELPER] WARNING: Missing Cloudflare R2 credentials or endpoint!');
}

const s3 = new S3Client({
  region: R2_REGION,
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// === Split script into scene objects ===
function splitScriptToScenes(script) {
  console.log(`[SCENE SPLIT] Splitting script into scenes...`);
  if (!script) return [];
  let lines = Array.isArray(script) ? script : script
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const scenes = lines.map((text, index) => ({
    id: `scene${index + 1}`,
    text,
  }));
  console.log(`[SCENE SPLIT] Split into ${scenes.length} scenes.`);
  return scenes;
}

// === GPT-4.1 subject extractor ===
async function extractMainSubject(line, videoTopic = '') {
  if (!OPENAI_API_KEY) return null;
  try {
    // Extremely focused visual subject prompt, NO metaphors
    const system = `You extract the REAL, VISUAL SUBJECT of a short scene line for a YouTube Short. Only return the best visual subject (landmark, object, place, person, etc). NO metaphors or quotes. If more than one thing, pick the most famous or most related to topic: "${videoTopic}". One short answer, no extra words.`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      temperature: 0,
      max_tokens: 15,
      messages: [
        { role: "system", content: system },
        { role: "user", content: line }
      ]
    });
    const out = completion.choices?.[0]?.message?.content?.trim() || '';
    console.log(`[SUBJECT] "${line}" → "${out}"`);
    return out;
  } catch (err) {
    console.error('[SUBJECT EXTRACTOR ERROR]', err.message);
    return null;
  }
}

// === Main scene matching function ===
// Usage: await findClipForScene(sceneText, sceneNum, scriptLines, videoTopic)
async function findClipForScene(sceneText, sceneNum = 1, scriptLines = [], videoTopic = '') {
  // Use scene 2's main subject for both 1 & 2
  let visualSubject;
  if (sceneNum === 1 && scriptLines && scriptLines.length > 1) {
    visualSubject = await extractMainSubject(scriptLines[1], videoTopic);
    console.log(`[MATCH] (Scene 1) Using subject from scene 2: "${visualSubject}"`);
  } else {
    visualSubject = await extractMainSubject(sceneText, videoTopic);
    console.log(`[MATCH] Scene ${sceneNum} subject: "${visualSubject}"`);
  }
  if (!visualSubject) {
    console.warn(`[MATCH] No subject extracted from: "${sceneText}"`);
    return null;
  }

  // Run all three searches in parallel, collect results
  const [r2Url, pexelsUrl, pixabayUrl] = await Promise.all([
    searchR2Library(visualSubject),
    fetchFromPexels(visualSubject),
    fetchFromPixabay(visualSubject)
  ]);

  // Score results (prefer R2, then Pexels, then Pixabay, but if none contain the *exact* keyword fallback to first found)
  const candidates = [
    { source: 'R2', url: r2Url },
    { source: 'Pexels', url: pexelsUrl },
    { source: 'Pixabay', url: pixabayUrl },
  ].filter(c => !!c.url);

  if (candidates.length === 0) {
    console.warn(`[MATCH] ❌ No match found for: "${visualSubject}"`);
    return null;
  }

  // Simple scoring: prefer match with subject/keyword in filename/url, prefer R2, then Pexels, then Pixabay
  const subjectLc = visualSubject.toLowerCase();
  let best = candidates[0];
  for (const c of candidates) {
    if (c.url.toLowerCase().includes(subjectLc)) {
      best = c;
      if (c.source === 'R2') break; // R2 with match is ideal
    }
  }
  console.log(`[MATCH] ✅ Best match from ${best.source}: ${best.url}`);
  return best.url;
}

// === R2 Search ===
async function searchR2Library(keyword) {
  if (!keyword) return null;
  console.log(`[R2] Searching R2 for: "${keyword}"`);
  try {
    const command = new ListObjectsV2Command({ Bucket: R2_LIBRARY_BUCKET });
    const data = await s3.send(command);
    if (!data.Contents || !Array.isArray(data.Contents)) {
      console.warn('[R2] No files found in library bucket.');
      return null;
    }
    const matches = data.Contents
      .map(obj => obj.Key)
      .filter(key => key && key.toLowerCase().includes(keyword.toLowerCase()))
      .sort((a, b) => a.toLowerCase().indexOf(keyword) - b.toLowerCase().indexOf(keyword));
    if (matches.length > 0) {
      const key = matches[0];
      const r2Url = `${R2_ENDPOINT.replace(/\/$/, '')}/${R2_LIBRARY_BUCKET}/${key}`;
      console.log(`[R2] ✅ Found match: ${key} | Full URL: ${r2Url}`);
      return r2Url;
    } else {
      console.warn(`[R2] ❌ No match found for: "${keyword}"`);
    }
  } catch (err) {
    console.error(`[R2 ERROR] Failed to search R2: ${err.message}`);
  }
  return null;
}

// === Fetch from Pexels ===
async function fetchFromPexels(query) {
  if (!PEXELS_API_KEY) return null;
  console.log(`[PEXELS] Searching Pexels for: "${query}"`);
  try {
    const res = await axios.get(`https://api.pexels.com/videos/search`, {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query, per_page: 1 }
    });
    const video = res.data.videos?.[0];
    if (video && video.video_files?.length) {
      const file = video.video_files.find(f => f.quality === 'sd' && f.width <= 720) || video.video_files[0];
      if (file && file.link) {
        console.log(`[PEXELS] ✅ Clip found: ${file.link}`);
        return file.link;
      }
    }
    console.warn(`[PEXELS] ❌ No usable clip returned`);
  } catch (err) {
    console.error(`[PEXELS ERROR] ${err.message}`);
  }
  return null;
}

// === Fetch from Pixabay ===
async function fetchFromPixabay(query) {
  if (!PIXABAY_API_KEY) return null;
  console.log(`[PIXABAY] Searching Pixabay for: "${query}"`);
  try {
    const res = await axios.get(`https://pixabay.com/api/videos/`, {
      params: {
        key: PIXABAY_API_KEY,
        q: query,
        safesearch: true,
        per_page: 3
      }
    });
    const hits = res.data.hits;
    if (hits && hits.length > 0) {
      const url = hits[0].videos?.medium?.url || hits[0].videos?.small?.url;
      if (url) {
        console.log(`[PIXABAY] ✅ Clip found: ${url}`);
        return url;
      }
    }
    console.warn(`[PIXABAY] ❌ No usable clip returned`);
  } catch (err) {
    console.error(`[PIXABAY ERROR] ${err.message}`);
  }
  return null;
}

// Export for server
module.exports = {
  splitScriptToScenes,
  findClipForScene,
  extractMainSubject, // in case you want to use it elsewhere
};

console.log('\n===========[ PEXELS HELPER LOADED | GPT SUBJECT + BEST MATCH | GOD TIER LOGGING READY ]============');
