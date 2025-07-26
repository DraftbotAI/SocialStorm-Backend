console.log('============= [PEXELS HELPER LOADED AT RUNTIME] =============');
console.log('[DEBUG] DEPLOY TEST', new Date());

/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   =========================================================== */
require('dotenv').config();
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
console.log('[Pexels Helper] Loaded – HARD FILTERING + MAX RELEVANCE MODE.');

/* ========== DEBUG: ENV VARS ========== */
console.log('[DEBUG] ENV R2_LIBRARY_BUCKET:', process.env.R2_LIBRARY_BUCKET);
console.log('[DEBUG] ENV R2_ENDPOINT:', process.env.R2_ENDPOINT);
console.log('[DEBUG] ENV R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID);
console.log('[DEBUG] ENV R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? '***' : 'MISSING');



/* ===========================================================
   SECTION 2: SPLIT SCRIPT TO SCENES
   - Splits input script into array of scene lines
   =========================================================== */
function splitScriptToScenes(script) {
  if (!script) return [];
  // Accepts period or new line as delimiter, trims lines, removes empty
  return script.split(/[\n\.]+/).map(l => l.trim()).filter(Boolean);
}



/* ===========================================================
   SECTION 3: GPT SUBJECT EXTRACTOR (VISUAL MATCH PHRASE PICKER)
   - Uses GPT-4.1 to pull clean visual subject/landmark/object per line
   =========================================================== */
async function getVisualSubject(line, openaiApiKey) {
  if (!line) return '';
  try {
    const openai = new OpenAI({ apiKey: openaiApiKey });
    const prompt = `Given this line from a script for a YouTube Short, extract the single most visually matchable object, landmark, or subject. Respond with just a single noun phrase—no explanation, no animals, no metaphors, no jokes.\n\nLine: "${line}"\n\nVisual subject:`;
    const completion = await openai.completions.create({
      model: "gpt-4-1106-preview",
      prompt,
      max_tokens: 14,
      temperature: 0.13,
      n: 1,
      stop: ['\n']
    });
    const subject = (completion.choices && completion.choices[0] && completion.choices[0].text || '').trim();
    return subject;
  } catch (e) {
    console.warn('[PEXELS-HELPER] Failed to get GPT visual subject:', e);
    return '';
  }
}



/* ===========================================================
   SECTION 4: S3 (R2) VIDEO CLIP SEARCH
   - Attempts to find a matching video in Cloudflare R2 library
   =========================================================== */
async function searchR2LibraryForClip(query, s3, bucketName) {
  try {
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    const response = await s3.send(command);
    if (!response.Contents) return null;
    // Super basic: just look for filename includes query (case-insensitive)
    const files = response.Contents.map(obj => obj.Key || '').filter(Boolean);
    const match = files.find(f => f.toLowerCase().includes(query.toLowerCase()));
    if (match) {
      return match;
    }
    return null;
  } catch (err) {
    console.error('[PEXELS-HELPER] R2 search error:', err);
    return null;
  }
}



/* ===========================================================
   SECTION 5: PEXELS API VIDEO CLIP SEARCH
   - Fallback: queries Pexels API for video matching the visual subject
   =========================================================== */
async function searchPexelsForClip(query, apiKey) {
  try {
    const resp = await axios.get('https://api.pexels.com/videos/search', {
      headers: { Authorization: apiKey },
      params: { query, per_page: 5 }
    });
    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      // Return the best-matching clip URL
      const clip = resp.data.videos[0];
      return clip.video_files[0].link;
    }
    return null;
  } catch (err) {
    console.error('[PEXELS-HELPER] Pexels search error:', err);
    return null;
  }
}



/* ===========================================================
   SECTION 6: PIXABAY API VIDEO CLIP SEARCH
   - Final fallback: queries Pixabay API for matching video
   =========================================================== */
async function searchPixabayForClip(query, apiKey) {
  try {
    const resp = await axios.get('https://pixabay.com/api/videos/', {
      params: { key: apiKey, q: query, per_page: 3 }
    });
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      // Return the best-matching clip URL
      const clip = resp.data.hits[0];
      return clip.videos.medium.url;
    }
    return null;
  } catch (err) {
    console.error('[PEXELS-HELPER] Pixabay search error:', err);
    return null;
  }
}



/* ===========================================================
   SECTION 7: MAIN CLIP MATCHER (ALL SOURCES)
   - Checks R2 library, then Pexels, then Pixabay, returns first match
   =========================================================== */
async function findBestClip(query, openaiApiKey, r2Client, bucket, pexelsApiKey, pixabayApiKey) {
  // Try Cloudflare R2 first
  let clip = await searchR2LibraryForClip(query, r2Client, bucket);
  if (clip) {
    console.log(`[PEXELS-HELPER] R2 match: ${clip}`);
    return { source: 'r2', url: clip };
  }
  // Try Pexels
  clip = await searchPexelsForClip(query, pexelsApiKey);
  if (clip) {
    console.log(`[PEXELS-HELPER] Pexels match: ${clip}`);
    return { source: 'pexels', url: clip };
  }
  // Try Pixabay
  clip = await searchPixabayForClip(query, pixabayApiKey);
  if (clip) {
    console.log(`[PEXELS-HELPER] Pixabay match: ${clip}`);
    return { source: 'pixabay', url: clip };
  }
  return null;
}



/* ===========================================================
   SECTION 8: AUDIO GENERATION HELPERS (POLLY, ELEVENLABS, ETC)
   - Generates audio for a scene using TTS provider and returns local file path
   =========================================================== */
async function generateSceneAudio(text, voice, outputPath, ttsProvider, ttsConfig) {
  if (!text || !voice || !outputPath) throw new Error('Missing params for audio generation');
  // Use the real TTS logic, no sample-audio.mp3 fallback
  if (ttsProvider === 'polly') {
    // AWS Polly logic
    const AWS = require('aws-sdk');
    const polly = new AWS.Polly({
      accessKeyId: ttsConfig.accessKeyId,
      secretAccessKey: ttsConfig.secretAccessKey,
      region: ttsConfig.region
    });
    const params = {
      Text: text,
      OutputFormat: 'mp3',
      VoiceId: voice
    };
    const data = await polly.synthesizeSpeech(params).promise();
    fs.writeFileSync(outputPath, data.AudioStream);
    return outputPath;
  } else if (ttsProvider === 'elevenlabs') {
    // ElevenLabs logic (implement as needed)
    // Placeholder — implement actual ElevenLabs call
    throw new Error('ElevenLabs TTS not implemented in pexels-helper.cjs');
  } else {
    throw new Error('Unknown TTS provider: ' + ttsProvider);
  }
}



/* ===========================================================
   SECTION 9: EXPORTS
   =========================================================== */
module.exports = {
  splitScriptToScenes,
  getVisualSubject,
  searchR2LibraryForClip,
  searchPexelsForClip,
  searchPixabayForClip,
  findBestClip,
  generateSceneAudio,
};



console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
