// ===============================
// SOCIALSTORMAI - PEXELS HELPER
// VIDEO MATCHING, R2 FALLBACKS
// GOD TIER LOGGING ON
// ===============================

console.log('\n===========[ PEXELS HELPER LOADED AT RUNTIME | GOD TIER LOGGING ENABLED ]============');
console.log('[LOG] [BOOT] Timestamp:', new Date());

// ====== DEPENDENCIES ======
require('dotenv').config();
const axios = require('axios');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');

// ========== ENV VAR LOGGING ==========
console.log('[LOG] [ENV] R2_LIBRARY_BUCKET:', process.env.R2_LIBRARY_BUCKET);
console.log('[LOG] [ENV] R2_ENDPOINT:', process.env.R2_ENDPOINT);
console.log('[LOG] [ENV] R2_ACCESS_KEY_ID:', process.env.R2_ACCESS_KEY_ID);
console.log('[LOG] [ENV] R2_SECRET_ACCESS_KEY:', process.env.R2_SECRET_ACCESS_KEY ? '***' : 'MISSING');
console.log('[LOG] [ENV] PEXELS_API_KEY:', process.env.PEXELS_API_KEY ? '***' : 'MISSING');
console.log('[LOG] [ENV] PIXABAY_API_KEY:', process.env.PIXABAY_API_KEY ? '***' : 'MISSING');
console.log('[LOG] [ENV] OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '***' : 'MISSING');

// ========== R2 S3 CLIENT ==========
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});
console.log('[LOG] [R2] S3Client initialized');

// ========== OPENAI CLIENT ==========
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
console.log('[LOG] [OpenAI] Client initialized');

// ========== PEXELS/PIXABAY BASE URLS ==========
const PEXELS_BASE_URL = 'https://api.pexels.com/videos/search';
const PIXABAY_BASE_URL = 'https://pixabay.com/api/videos/';
console.log('[LOG] [PEXELS] Base URL:', PEXELS_BASE_URL);
console.log('[LOG] [PIXABAY] Base URL:', PIXABAY_BASE_URL);

// ========================================================================
// FUNCTION: SEARCH R2 LIBRARY (RETURNS FIRST MATCHING VIDEO, OR NULL)
// ========================================================================
async function searchR2Library(query, allowLogs = true) {
  if (allowLogs) console.log('\n[LOG] [R2] Entered searchR2Library() | Query:', query);
  try {
    const bucket = process.env.R2_LIBRARY_BUCKET;
    if (allowLogs) console.log('[LOG] [R2] Listing objects for bucket:', bucket);
    const data = await r2Client.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (allowLogs) console.log('[LOG] [R2] Objects fetched:', data.Contents?.length || 0);

    if (!data.Contents || !Array.isArray(data.Contents)) {
      if (allowLogs) console.log('[LOG] [R2] No contents in bucket.');
      return null;
    }

    // Lowercase and replace non-alphanumerics for matching
    const cleanQuery = query.toLowerCase().replace(/[^a-z0-9]/g, '');
    let bestMatch = null;
    let bestScore = 0;

    for (const obj of data.Contents) {
      const fname = obj.Key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (fname.includes(cleanQuery)) {
        // Naive scoring: longer matches = higher
        const score = cleanQuery.length / fname.length;
        if (score > bestScore) {
          bestMatch = obj.Key;
          bestScore = score;
        }
      }
    }
    if (bestMatch) {
      if (allowLogs) console.log('[LOG] [R2] Found matching file:', bestMatch, 'Score:', bestScore);
      return `https://${process.env.R2_PUBLIC_DOMAIN}/${bestMatch}`;
    } else {
      if (allowLogs) console.log('[LOG] [R2] No match found for query:', query);
      return null;
    }
  } catch (err) {
    console.error('[ERROR] [R2] searchR2Library:', err);
    return null;
  }
}

// ========================================================================
// FUNCTION: SEARCH PEXELS (RETURNS BEST MATCHING CLIP OR NULL)
// ========================================================================
async function searchPexels(query, allowLogs = true) {
  if (allowLogs) console.log('\n[LOG] [PEXELS] Entered searchPexels() | Query:', query);

  try {
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) {
      if (allowLogs) console.log('[WARN] [PEXELS] No API key set.');
      return null;
    }

    const resp = await axios.get(PEXELS_BASE_URL, {
      params: { query, per_page: 8 },
      headers: { Authorization: apiKey }
    });

    if (allowLogs) console.log('[LOG] [PEXELS] API response status:', resp.status, '| Results:', resp.data.videos?.length || 0);

    if (!resp.data || !resp.data.videos || resp.data.videos.length === 0) {
      if (allowLogs) console.log('[LOG] [PEXELS] No results found for query:', query);
      return null;
    }

    // Pick the highest resolution available for first video
    const best = resp.data.videos[0];
    const url = best.video_files?.find(v => v.quality === "hd")?.link
             || best.video_files?.[0]?.link
             || null;

    if (url) {
      if (allowLogs) console.log('[LOG] [PEXELS] Returning HD video:', url);
      return url;
    } else {
      if (allowLogs) console.log('[LOG] [PEXELS] No valid video url found in API response.');
      return null;
    }
  } catch (err) {
    if (err.response) {
      console.error('[ERROR] [PEXELS] API response:', err.response.status, err.response.data);
    } else {
      console.error('[ERROR] [PEXELS] Exception:', err);
    }
    return null;
  }
}

// ========================================================================
// FUNCTION: SEARCH PIXABAY (RETURNS BEST MATCHING CLIP OR NULL)
// ========================================================================
async function searchPixabay(query, allowLogs = true) {
  if (allowLogs) console.log('\n[LOG] [PIXABAY] Entered searchPixabay() | Query:', query);

  try {
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) {
      if (allowLogs) console.log('[WARN] [PIXABAY] No API key set.');
      return null;
    }
    const resp = await axios.get(PIXABAY_BASE_URL, {
      params: { key: apiKey, q: query, per_page: 8, safesearch: true }
    });

    if (allowLogs) console.log('[LOG] [PIXABAY] API response status:', resp.status, '| Results:', resp.data.hits?.length || 0);

    if (!resp.data || !resp.data.hits || resp.data.hits.length === 0) {
      if (allowLogs) console.log('[LOG] [PIXABAY] No results found for query:', query);
      return null;
    }

    // Pick the highest resolution mp4
    const best = resp.data.hits[0];
    const url = best.videos?.large?.url || best.videos?.medium?.url || best.videos?.small?.url || null;
    if (url) {
      if (allowLogs) console.log('[LOG] [PIXABAY] Returning video url:', url);
      return url;
    } else {
      if (allowLogs) console.log('[LOG] [PIXABAY] No valid video url found in API response.');
      return null;
    }
  } catch (err) {
    if (err.response) {
      console.error('[ERROR] [PIXABAY] API response:', err.response.status, err.response.data);
    } else {
      console.error('[ERROR] [PIXABAY] Exception:', err);
    }
    return null;
  }
}

// ========================================================================
// MAIN FUNCTION: findBestClipMatch
// Tries R2 first, then Pexels, then Pixabay, returns FIRST valid url.
// ========================================================================
async function findBestClipMatch(query, allowLogs = true) {
  console.log('\n[LOG] [MATCHER] Called findBestClipMatch | Query:', query);

  // Step 1: Try R2
  const r2Url = await searchR2Library(query, allowLogs);
  if (r2Url) {
    console.log('[LOG] [MATCHER] R2 match FOUND:', r2Url);
    return { source: 'r2', url: r2Url };
  }
  console.log('[LOG] [MATCHER] No R2 match for:', query);

  // Step 2: Try Pexels
  const pexelsUrl = await searchPexels(query, allowLogs);
  if (pexelsUrl) {
    console.log('[LOG] [MATCHER] Pexels match FOUND:', pexelsUrl);
    return { source: 'pexels', url: pexelsUrl };
  }
  console.log('[LOG] [MATCHER] No Pexels match for:', query);

  // Step 3: Try Pixabay
  const pixabayUrl = await searchPixabay(query, allowLogs);
  if (pixabayUrl) {
    console.log('[LOG] [MATCHER] Pixabay match FOUND:', pixabayUrl);
    return { source: 'pixabay', url: pixabayUrl };
  }
  console.log('[LOG] [MATCHER] No Pixabay match for:', query);

  // If none found
  console.log('[LOG] [MATCHER] No clip found in any source for:', query);
  return null;
}

// ========================================================================
// GPT-POWERED SUBJECT EXTRACTOR (OPTIONAL, LOGGED)
// ========================================================================
async function extractVisualSubject(line, mainTopic = '', allowLogs = true) {
  if (allowLogs) console.log('\n[LOG] [GPT] extractVisualSubject | Line:', line, '| MainTopic:', mainTopic);
  if (!process.env.OPENAI_API_KEY) {
    if (allowLogs) console.log('[WARN] [GPT] No OPENAI_API_KEY set. Skipping subject extraction.');
    return mainTopic || line;
  }
  try {
    const prompt = `
Given this script line for a viral video, return ONLY the best real-world subject to search for a matching video clip. Ignore metaphors, jokes, or generic terms. If multiple real things are present, pick the most famous or visual.
Script line: "${line}"
Main topic of the video: "${mainTopic}"
Return just the best visual subject, not a sentence.`;
    if (allowLogs) console.log('[LOG] [GPT] Prompt:', prompt);

    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 18,
      temperature: 0.1,
    });

    const subject = (completion.choices?.[0]?.message?.content || '').replace(/\n/g, '').trim();
    if (allowLogs) console.log('[LOG] [GPT] Subject returned:', subject);
    return subject || mainTopic || line;
  } catch (err) {
    console.error('[ERROR] [GPT] extractVisualSubject:', err);
    return mainTopic || line;
  }
}

// ========================================================================
// EXPORTS
// ========================================================================
module.exports = {
  searchR2Library,
  searchPexels,
  searchPixabay,
  findBestClipMatch,
  extractVisualSubject
};

console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
