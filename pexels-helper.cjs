/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - DUMMY PATCH: Always returns local outro.mp4 for all scenes.
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
  // (Leave this as-is, not used in the dummy below)
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

// --- DUMMY MAIN MATCHER ---
// This always returns your local outro.mp4 for every scene.
async function findClipForScene(sceneText, idx, allLines = [], title = '', s3Client, usedClips = []) {
  // Always use outro.mp4 because you have it!
  const testClipPath = path.resolve(__dirname, 'public', 'assets', 'outro.mp4');
  if (!fs.existsSync(testClipPath)) {
    console.error(`[DUMMY MATCHER] outro.mp4 not found at ${testClipPath}. Please add your test video!`);
    throw new Error('Test video file not found.');
  }
  console.log(`[DUMMY MATCHER] Returning outro.mp4 for scene ${idx + 1}`);
  return {
    url: testClipPath,
    file: 'outro.mp4'
  };
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
  downloadRemoteFileToLocal,
  extractVisualSubject // <--- Exported so you can import in server.cjs!
};
