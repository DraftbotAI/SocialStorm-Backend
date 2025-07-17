// =============================
// PEXELS HELPER – BULLETPROOF EDITION (FIXED)
// =============================

require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

console.log('[Pexels Helper] Dependencies loaded.');

// ========== CONFIG ==========
const STOP_WORDS = new Set([
  'and', 'the', 'with', 'into', 'for', 'a', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'has', 'have', 'had'
]);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const LOCAL_CLIP_DIR = path.join(__dirname, 'clips');
const TEMP_DIR = path.join(__dirname, 'tmp');

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(LOCAL_CLIP_DIR, { recursive: true });

// ========== HELPERS ==========

function ensureArray(url) {
  if (Array.isArray(url)) return url;
  console.log(`[ensureArray] Wrapped single URL into array: ${url}`);
  return [url];
}

function sanitizeQuery(raw, maxWords = 10) {
  const cleaned = raw
    .replace(/["""''.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
  console.log(`[sanitizeQuery] Cleaned query: "${cleaned}"`);
  return cleaned;
}

async function extractMainSubject(line) {
  try {
    const { OpenAI } = require('openai');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log(`[extractMainSubject] Extracting from: "${line}"`);
    const resp = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: "Extract main subject of script (1-2 words, lowercase)." },
        { role: 'user', content: line }
      ],
      temperature: 0.1,
      max_tokens: 8
    });
    let subject = resp.choices[0].message.content.trim().toLowerCase().split('\n')[0];
    const cleaned = subject.replace(/[^a-z0-9 ]+/gi, '').trim();
    if (!cleaned) throw new Error("Empty subject");
    console.log(`[extractMainSubject] Subject extracted: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    const fallback = sanitizeQuery(line, 3).split(' ')[0] || 'nature';
    console.warn(`[extractMainSubject] Fallback to "${fallback}": ${err.message}`);
    return fallback;
  }
}

async function downloadToLocal(urls, workDir = TEMP_DIR) {
  urls = ensureArray(urls);
  for (let url of urls) {
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
    const dest = path.join(workDir, `remote_${hash}_${Date.now()}.mp4`);
    if (fs.existsSync(dest)) {
      console.log(`[downloadToLocal] Already exists: ${dest}`);
      return dest;
    }
    try {
      console.log(`[downloadToLocal] Downloading from: ${url}`);
      const response = await axios.get(url, { responseType: 'stream', timeout: 15000 });
      await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(dest);
        response.data.pipe(w);
        w.on('finish', resolve);
        w.on('error', reject);
      });
      console.log(`[downloadToLocal] Downloaded successfully: ${dest}`);
      return dest;
    } catch (err) {
      console.error(`[downloadToLocal] Failed downloading ${url}: ${err.message}`);
    }
  }
  return null;
}

// ========== R2 CLOUD STORAGE FUNCTIONS ==========
async function findBestVideoFromR2(query) {
  try {
    console.log(`[findBestVideoFromR2] Searching R2 for: "${query}"`);
    
    const command = new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET_NAME,
      Prefix: 'videos/',
      MaxKeys: 100
    });

    const response = await s3.send(command);
    
    if (!response.Contents || response.Contents.length === 0) {
      console.log('[findBestVideoFromR2] No videos found in R2');
      return null;
    }

    const videoFiles = response.Contents
      .filter(obj => obj.Key.endsWith('.mp4'))
      .map(obj => ({
        key: obj.Key,
        name: path.basename(obj.Key, '.mp4').toLowerCase(),
        url: `${process.env.R2_PUBLIC_URL}/${obj.Key}`
      }));

    if (videoFiles.length === 0) {
      console.log('[findBestVideoFromR2] No MP4 files found in R2');
      return null;
    }

    // Find best match using string similarity
    const queryLower = query.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const video of videoFiles) {
      const score = stringSimilarity.compareTwoStrings(queryLower, video.name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = video;
      }
    }

    if (bestMatch && bestScore > 0.1) {
      console.log(`[findBestVideoFromR2] Found match: ${bestMatch.name} (score: ${bestScore})`);
      return bestMatch.url;
    }

    console.log('[findBestVideoFromR2] No suitable match found');
    return null;
  } catch (err) {
    console.error(`[findBestVideoFromR2] Error: ${err.message}`);
    return null;
  }
}

// ========== PEXELS API FUNCTIONS ==========
async function getPexelsVideo(query) {
  try {
    if (!process.env.PEXELS_API_KEY) {
      console.warn('[getPexelsVideo] No Pexels API key found');
      return null;
    }

    console.log(`[getPexelsVideo] Searching Pexels for: "${query}"`);
    
    const response = await axios.get('https://api.pexels.com/videos/search', {
      params: {
        query: sanitizeQuery(query),
        per_page: 10,
        orientation: 'landscape'
      },
      headers: {
        'Authorization': process.env.PEXELS_API_KEY
      },
      timeout: 10000
    });

    if (!response.data.videos || response.data.videos.length === 0) {
      console.log('[getPexelsVideo] No videos found on Pexels');
      return null;
    }

    const video = response.data.videos[0];
    const videoFile = video.video_files.find(file => 
      file.quality === 'hd' || file.quality === 'sd'
    ) || video.video_files[0];

    console.log(`[getPexelsVideo] Found video: ${videoFile.link}`);
    return videoFile.link;
  } catch (err) {
    console.error(`[getPexelsVideo] Error: ${err.message}`);
    return null;
  }
}

// ========== PIXABAY API FUNCTIONS ==========
async function getPixabayVideo(query) {
  try {
    if (!process.env.PIXABAY_API_KEY) {
      console.warn('[getPixabayVideo] No Pixabay API key found');
      return null;
    }

    console.log(`[getPixabayVideo] Searching Pixabay for: "${query}"`);
    
    const response = await axios.get('https://pixabay.com/api/videos/', {
      params: {
        key: process.env.PIXABAY_API_KEY,
        q: sanitizeQuery(query),
        video_type: 'film',
        per_page: 10
      },
      timeout: 10000
    });

    if (!response.data.hits || response.data.hits.length === 0) {
      console.log('[getPixabayVideo] No videos found on Pixabay');
      return null;
    }

    const video = response.data.hits[0];
    const videoUrl = video.videos.medium?.url || video.videos.small?.url;

    if (videoUrl) {
      console.log(`[getPixabayVideo] Found video: ${videoUrl}`);
      return videoUrl;
    }

    console.log('[getPixabayVideo] No suitable video format found');
    return null;
  } catch (err) {
    console.error(`[getPixabayVideo] Error: ${err.message}`);
    return null;
  }
}

// ========== FALLBACK FUNCTIONS ==========
function getLocalFallback() {
  try {
    console.log('[getLocalFallback] Checking for local fallback videos');
    
    if (!fs.existsSync(LOCAL_CLIP_DIR)) {
      console.log('[getLocalFallback] Local clips directory does not exist');
      return null;
    }

    const files = fs.readdirSync(LOCAL_CLIP_DIR)
      .filter(file => file.endsWith('.mp4'))
      .map(file => path.join(LOCAL_CLIP_DIR, file));

    if (files.length === 0) {
      console.log('[getLocalFallback] No local MP4 files found');
      return null;
    }

    const randomFile = files[Math.floor(Math.random() * files.length)];
    console.log(`[getLocalFallback] Using local fallback: ${randomFile}`);
    return randomFile;
  } catch (err) {
    console.error(`[getLocalFallback] Error: ${err.message}`);
    return null;
  }
}

function getGenericFallback() {
  console.log('[getGenericFallback] Using generic fallback');
  
  // List of generic stock video URLs (you can replace these with your own)
  const genericVideos = [
    'https://sample-videos.com/zip/10/mp4/SampleVideo_1280x720_1mb.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4'
  ];

  const randomVideo = genericVideos[Math.floor(Math.random() * genericVideos.length)];
  console.log(`[getGenericFallback] Using generic video: ${randomVideo}`);
  return randomVideo;
}

// ========== UNIVERSAL, NEVER-FAIL PICK CLIP FUNCTION ==========
async function pickClipFor(rawQuery, tempDir = TEMP_DIR, mainSubject = '') {
  console.log(`[pickClipFor] Starting search for: "${rawQuery}"`);

  let subject = mainSubject || await extractMainSubject(rawQuery) || 'nature';

  let sources = [
    { name: 'Cloud R2', method: findBestVideoFromR2 },
    { name: 'Pexels', method: getPexelsVideo },
    { name: 'Pixabay', method: getPixabayVideo }
  ];

  for (let source of sources) {
    console.log(`[pickClipFor] Trying ${source.name}...`);
    try {
      let url = await source.method(subject);
      if (url) {
        let localPath = await downloadToLocal(url, tempDir);
        if (localPath) {
          return { type: 'video', url: localPath, originalUrl: url, source: source.name };
        }
      }
    } catch (err) {
      console.error(`[pickClipFor] Error with ${source.name}: ${err.message}`);
    }
  }

  let localFallback = getLocalFallback();
  if (localFallback) return { type: 'video', url: localFallback, source: 'local_fallback' };

  let genericFallback = getGenericFallback();
  if (genericFallback) return { type: 'video', url: genericFallback, source: 'generic_fallback' };

  console.error(`[pickClipFor] TOTAL FAIL for "${rawQuery}"`);
  return null;
}

module.exports = { pickClipFor };
console.log('[Pexels Helper] Export complete.');