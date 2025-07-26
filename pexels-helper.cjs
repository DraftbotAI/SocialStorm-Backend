// =============================================================
// PEXELS-HELPER.CJS: Video Clip Selection + Main Subject Extractor
// For SocialStormAI (R2 → Pexels → Pixabay, GPT-powered, no dupes)
// =============================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { OpenAI } = require('openai');

const R2_BUCKET = process.env.R2_LIBRARY_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_PREFIX = process.env.R2_PREFIX || '';

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================== R2 CLIENT ==================
const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  }
});

// ================== MAIN SUBJECT EXTRACTOR ==================
async function extractMainSubject(text) {
  // Use GPT-4.1 to extract the main visual subject or fallback to keywords
  try {
    const prompt = `Extract the main *visual* subject (landmark, person, object, place, etc.) from this sentence for a short video. ONLY return a short, search-friendly phrase. No metaphors.\n\n"${text}"\n\nVisual Subject:`;
    const resp = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 16,
      temperature: 0.25
    });
    let out = (resp.choices[0]?.message?.content || '').replace(/^[^\w]*|[^\w]*$/g, '').trim();
    if (!out) out = text;
    return out;
  } catch (e) {
    // Fallback to input text (for dev only)
    return text;
  }
}

// ================== R2 CLIP SEARCH ==================
async function searchR2Clips(subject, usedClips = new Set()) {
  // List all objects in R2_BUCKET and match best
  const listParams = {
    Bucket: R2_BUCKET,
    Prefix: R2_PREFIX,
    MaxKeys: 1000,
  };
  const data = await r2Client.send(new ListObjectsV2Command(listParams));
  let files = (data.Contents || []).map(obj => obj.Key).filter(
    f => f.endsWith('.mp4') || f.endsWith('.mov')
  );
  // Filter out used
  files = files.filter(f => !usedClips.has(f));
  // Fuzzy match subject
  let best = files.find(f => f.toLowerCase().includes(subject.toLowerCase()));
  if (best) {
    return {
      clipPath: `https://${R2_BUCKET}.${R2_ENDPOINT.replace('https://', '')}/${best}`,
      clipSource: 'R2'
    };
  }
  return null;
}

// ================== PEXELS CLIP SEARCH ==================
async function searchPexels(subject, usedClips = new Set()) {
  try {
    const resp = await axios.get('https://api.pexels.com/videos/search', {
      params: { query: subject, per_page: 10 },
      headers: { Authorization: PEXELS_API_KEY }
    });
    const vids = resp.data.videos || [];
    for (const vid of vids) {
      const url = vid.video_files?.[0]?.link;
      if (url && !usedClips.has(url)) {
        return { clipPath: url, clipSource: 'Pexels' };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ================== PIXABAY CLIP SEARCH ==================
async function searchPixabay(subject, usedClips = new Set()) {
  try {
    const resp = await axios.get('https://pixabay.com/api/videos/', {
      params: { key: PIXABAY_API_KEY, q: subject, per_page: 10 },
    });
    const vids = resp.data.hits || [];
    for (const vid of vids) {
      const url = vid.videos?.medium?.url;
      if (url && !usedClips.has(url)) {
        return { clipPath: url, clipSource: 'Pixabay' };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ================== SMART CLIP FINDER ==================
async function findClipSmart(subject, usedClips = new Set()) {
  // Search R2 first, then Pexels, then Pixabay
  let res = await searchR2Clips(subject, usedClips);
  if (res) return res;
  res = await searchPexels(subject, usedClips);
  if (res) return res;
  res = await searchPixabay(subject, usedClips);
  if (res) return res;
  // Fallback: null
  throw new Error('No video clip found for subject: ' + subject);
}

// ================== EXPORTS ==================
module.exports = {
  extractMainSubject,
  findClipSmart
};
