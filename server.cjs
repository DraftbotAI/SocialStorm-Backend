// ==========================================
// 1. CANVAS & JSZIP IMPORTS (Used for thumbnails/zips if needed)
// ==========================================
const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');
console.log('[1] Canvas and JSZip modules loaded.');

// ==========================================
// 2. DIRECTORY DEBUGGING (DEV ONLY)
// ==========================================
console.log('[2] Working directory:', __dirname);
console.log('[2] Files/folders here:', require('fs').readdirSync(__dirname));
if (require('fs').existsSync(require('path').join(__dirname, 'frontend'))) {
  console.log('[2] Frontend folder contents:', require('fs').readdirSync(require('path').join(__dirname, 'frontend')));
} else {
  console.log('[2] No frontend folder found!');
}

// ==========================================
// 3. ENVIRONMENT & DEPENDENCY SETUP
// ==========================================
require('dotenv').config();
const express        = require('express');
const cors           = require('cors');
const axios          = require('axios');
const fs             = require('fs');
const path           = require('path');
const { v4: uuidv4 } = require('uuid');
const AWS            = require('aws-sdk');
const ffmpegPath     = require('ffmpeg-static');
const ffmpeg         = require('fluent-ffmpeg');
const { pickClipFor }= require('./pexels-helper.cjs');
const { OpenAI }     = require('openai');
console.log('[3] Dependencies imported.');

ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[3] FFmpeg path set:', ffmpegPath);

// AWS Polly config
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
const polly = new AWS.Polly();
console.log('[3] AWS Polly client configured.');

// ==========================================
// 4. PROGRESS TRACKING MAP
// ==========================================
const progress = {};
const JOB_TTL_MS = 5 * 60 * 1000;
function cleanupJob(jobId, delay = JOB_TTL_MS) {
  setTimeout(() => { 
    delete progress[jobId]; 
    console.log(`[4] Cleaned up job from progress map: ${jobId}`); 
  }, delay);
  console.log(`[4] Scheduled cleanup for job ${jobId} in ${delay/1000}s`);
}

// ==========================================
// 5. EXPRESS APP INITIALIZATION
// ==========================================
const app = express();
app.use((req, res, next) => {
  console.log(`[5] [${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(__dirname, 'frontend')));
console.log('[5] Static serving enabled for frontend directory.');
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/voice-previews', express.static(path.join(__dirname, 'frontend', 'voice-previews')));
const PORT = process.env.PORT || 3000;
console.log('[5] Express app initialized. PORT:', PORT);

// ==========================================
// 6. CLOUD R2 CLIENT CONFIGURATION
// ==========================================
const { S3, Endpoint } = AWS;
const s3 = new S3({
  endpoint: new Endpoint(process.env.R2_ENDPOINT),
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'us-east-1',
});
console.log('[6] Cloudflare R2 S3 client configured. Bucket:', process.env.R2_BUCKET);

// ==========================================
// 7. HELPERS
// ==========================================
const stringSimilarity = require('string-similarity');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const R2_CLIP_PREFIX = 'clips/'; // adjust if your R2 videos are under another path
const R2_CACHE_FILE = path.join(__dirname, 'cache', 'r2-clip-list.json');

// Utility: fetch and cache R2 clip list to avoid slow API calls each scene
async function getR2ClipList(safe = false) {
  try {
    if (fs.existsSync(R2_CACHE_FILE)) {
      const age = Date.now() - fs.statSync(R2_CACHE_FILE).mtimeMs;
      if (age < 5 * 60 * 1000) // cache fresh for 5 minutes
        return JSON.parse(fs.readFileSync(R2_CACHE_FILE, 'utf8'));
    }
    const data = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: R2_CLIP_PREFIX
    }));
    const clipList = (data.Contents || []).map(obj => obj.Key);
    fs.mkdirSync(path.dirname(R2_CACHE_FILE), { recursive: true });
    fs.writeFileSync(R2_CACHE_FILE, JSON.stringify(clipList));
    console.log(`[7] getR2ClipList: fetched and cached ${clipList.length} clips.`);
    return clipList;
  } catch (err) {
    if (!safe) throw err;
    console.warn('[7] getR2ClipList: error or unavailable, returning empty:', err.message);
    return [];
  }
}

// Download a file from R2 by key to local path
async function downloadFromR2ToFile(r2Key, dest) {
  const params = { Bucket: process.env.R2_BUCKET, Key: r2Key };
  try {
    const data = await s3.getObject(params).promise();
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, data.Body);
    console.log(`[7] downloadFromR2ToFile: Downloaded ${r2Key} to ${dest}`);
  } catch (err) {
    console.error(`[7] downloadFromR2ToFile error: ${err.message}`);
    throw err;
  }
}

// Main helper: find best clip for a scene by R2, then Pexels, then Pixabay, then fallback
async function findBestClipForScene(sceneText, workDir) {
  const mainSubject = await extractMainSubject(sceneText);
  const keywords = [mainSubject, ...sanitizeQuery(sceneText).split(' ').slice(0,2), 'nature', 'animal', 'background'];
  let triedSources = [];

  // 1. R2 Cloudflare search (fuzzy match)
  try {
    const clipList = await getR2ClipList(true);
    const names = clipList.map(key => key.toLowerCase());
    for (let kw of keywords) {
      const best = stringSimilarity.findBestMatch(kw.toLowerCase(), names);
      if (best.bestMatch.rating > 0.28) { // low threshold to ensure some match
        const key = clipList[best.bestMatchIndex];
        triedSources.push(`R2:${key}`);
        const localDest = path.join(workDir, path.basename(key));
        await downloadFromR2ToFile(key, localDest);
        console.log(`[7] findBestClipForScene: Using R2 clip: ${key}`);
        return localDest;
      }
    }
  } catch (err) {
    console.warn(`[7] R2 search failed: ${err.message}`);
  }

  // 2. Pexels search (by keyword)
  try {
    for (let kw of keywords) {
      const pexelsPath = await getClipFromPexels(kw, workDir);
      if (pexelsPath) {
        triedSources.push(`Pexels:${kw}`);
        console.log(`[7] findBestClipForScene: Using Pexels clip for "${kw}"`);
        return pexelsPath;
      }
    }
  } catch (err) {
    console.warn(`[7] Pexels search failed: ${err.message}`);
  }

  // 3. Pixabay search (by keyword)
  try {
    for (let kw of keywords) {
      const pixabayPath = await getClipFromPixabay(kw, workDir);
      if (pixabayPath) {
        triedSources.push(`Pixabay:${kw}`);
        console.log(`[7] findBestClipForScene: Using Pixabay clip for "${kw}"`);
        return pixabayPath;
      }
    }
  } catch (err) {
    console.warn(`[7] Pixabay search failed: ${err.message}`);
  }

  // 4. Local fallback directory
  try {
    const localFallbackDir = path.join(__dirname, 'clips');
    if (fs.existsSync(localFallbackDir)) {
      const files = fs.readdirSync(localFallbackDir).filter(f => f.endsWith('.mp4'));
      if (files.length) {
        const chosen = files[Math.floor(Math.random() * files.length)];
        console.log(`[7] findBestClipForScene: Using random local fallback: ${chosen}`);
        return path.join(localFallbackDir, chosen);
      }
    }
  } catch (err) {
    console.warn(`[7] Local fallback search failed: ${err.message}`);
  }

  // 5. Final fail: log and return null
  console.error(`[7] findBestClipForScene: FAILED for scene: "${sceneText}". Tried sources:`, triedSources);
  return null;
}

// NOTE: You must implement or import these helper functions:
//  - getClipFromPexels(keyword, workDir)
//  - getClipFromPixabay(keyword, workDir)

module.exports = {
  getR2ClipList,
  downloadFromR2ToFile,
  findBestClipForScene,
};
console.log('[7] Exported helpers: getR2ClipList, downloadFromR2ToFile, findBestClipForScene');


// ==========================================
// 8. VIRAL METADATA ENGINE (ENHANCED FOR VIRAL PERFORMANCE)
// ==========================================
async function generateViralMetadata({ script, topic, oldTitle, oldDesc }) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const metaPrompt = `
You are a top YouTube Shorts viral content strategist. For the following script and topic, do the following:
1. Write a viral, clickable TITLE (max 62 characters). Use curiosity, emotion, cliffhangers, or “never knew,” “shocking,” “secret,” etc. Avoid all-caps, exclamation points, and generic language. Focus on high-CTR hooks and SEO keywords, but make it sound natural.
2. Write a 2–3 sentence DESCRIPTION that summarizes the video, starts with a compelling hook, works in the main topic/subject, and ends with a soft call to action like “Follow for more” or “Subscribe for crazy facts.” SEO and intrigue are key. No emojis, no hashtags here.
3. Give a stack of 14–18 hashtags (comma separated, no numbers, all must start with #, no #shorts as the first). Include highly relevant, trending, and niche tags for the topic. Use main subject and viral YouTube Shorts keywords, and at least one hashtag should be highly specific.

Do **NOT** use emojis anywhere. Prioritize real clickbait, curiosity, and YouTube Shorts growth.

TOPIC: ${topic}
SCRIPT: ${script}

Format:
TITLE: [title]
DESCRIPTION: [desc]
HASHTAGS: [hashtag1, hashtag2, ...]
`.trim();

    const out = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: metaPrompt }],
      temperature: 0.93,
      max_tokens: 380,
    });

    const text = out.choices[0].message.content.trim();

    // Parse results out of OpenAI output
    const titleMatch = text.match(/TITLE:\s*(.+?)\s*DESCRIPTION:/is);
    const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+?)HASHTAGS:/is);
    const hashtagsMatch = text.match(/HASHTAGS:\s*(.+)$/i);

    let viralTitle = stripEmojis(titleMatch ? titleMatch[1].trim() : oldTitle);
    // Strict length cap for Shorts
    if (viralTitle.length > 62) viralTitle = viralTitle.slice(0, 59) + "...";

    let viralDesc = stripEmojis(descMatch ? descMatch[1].replace(/\n/g, ' ').replace(/\s+/g, ' ').trim() : oldDesc);
    if (viralDesc.length > 180) viralDesc = viralDesc.slice(0, 177) + "...";

    let viralTags = stripEmojis(hashtagsMatch ? hashtagsMatch[1].replace(/[\s,]+/g, ', ').trim() : '');

    // Remove duplicate hashtags, keep first appearance only
    if (viralTags) {
      let tagsArr = viralTags.split(',').map(t => t.trim().toLowerCase()).filter(t => t.startsWith('#'));
      let uniqueTags = Array.from(new Set(tagsArr));
      viralTags = uniqueTags.join(', ');
    }

    console.log('[8] Viral metadata generated:', { viralTitle, viralDesc, viralTags });
    return { viralTitle, viralDesc, viralTags };
  } catch (err) {
    console.error("[8] Viral metadata fallback, error:", err.message);
    return { viralTitle: oldTitle, viralDesc: oldDesc, viralTags: '' };
  }
}

// ==========================================
// 9. SCRIPT-TO-SCENES SPLITTER (ELEVENLABS & POLLY ONLY)
// ==========================================
function splitScriptToScenes(script) {
  const scenesArr = script
    .split(/(?<=[\.!\?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
  console.log('[9] splitScriptToScenes:', scenesArr.length, 'scenes');
  return scenesArr;
}
// (No Google TTS client or credentials!)

// ==========================================
// 10. ELEVENLABS & AMAZON POLLY TTS SYNTHESIZER & UTILS
// ==========================================

/**
 * Synthesize speech with ElevenLabs TTS API.
 * @param {string} text - The line of script to convert to speech.
 * @param {string} voice - ElevenLabs voice ID.
 * @param {string} outFile - Where to save the resulting MP3.
 * @returns {Promise<string>} - Resolves to the outFile path.
 */
async function synthesizeWithElevenLabs(text, voice, outFile) {
  try {
    console.log(`[10] synthesizeWithElevenLabs: "${voice}" → ${outFile}`);
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      { text, model_id: 'eleven_monolingual_v1' },
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer',
      }
    );
    fs.writeFileSync(outFile, ttsRes.data);
    console.log(`[10] ElevenLabs file written: ${outFile}`);
    return outFile;
  } catch (err) {
    console.error('[10] ElevenLabs error:', err.message);
    throw new Error('ElevenLabs error: ' + err.message);
  }
}

/**
 * Synthesize speech with Amazon Polly.
 * @param {string} text - The line of script to convert to speech.
 * @param {string} voice - Polly voice ID.
 * @param {string} outFile - Where to save the resulting MP3.
 * @returns {Promise<string>} - Resolves to the outFile path.
 */
async function synthesizeWithPolly(text, voice, outFile) {
  console.log(`[10] synthesizeWithPolly: "${voice}" → ${outFile}`);
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: voice,
    Engine: 'neural'
  };
  return new Promise((resolve, reject) => {
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        console.error('[10] Polly error:', err.message);
        return reject(new Error('Polly error: ' + err.message));
      }
      if (data && data.AudioStream instanceof Buffer) {
        fs.writeFileSync(outFile, data.AudioStream);
        console.log(`[10] Polly file written: ${outFile}`);
        resolve(outFile);
      } else {
        reject(new Error('Polly synthesis failed, no audio stream.'));
      }
    });
  });
}

// ======= UTIL: Promise Timeout =======
/**
 * Promise with a timeout (to prevent hangs).
 * @param {Promise} promise
 * @param {number} ms
 * @param {string} msg
 * @returns {Promise}
 */
function promiseTimeout(promise, ms, msg = 'timed out') {
  let timeout;
  const t = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, t]).then((val) => {
    clearTimeout(timeout);
    return val;
  });
}

// ==========================================
// 11. VOICES & /api/voices ENDPOINT
// ==========================================
function getVoicePreviewFile(id, fallback = null) {
  const previewDir = '/voice-previews/';
  const pattern = `${id}.mp3`;
  if (fs.existsSync(path.join(__dirname, 'frontend', 'voice-previews', pattern))) {
    return `${previewDir}${pattern}`;
  }
  return fallback;
}

// ElevenLabs Pro Voices (all disabled by default)
const elevenProVoices = [
  { id: "ZthjuvLPty3kTMaNKVKb", name: "Mike (Pro)", description: "ElevenLabs, Deep US Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "6F5Zhi321D3Oq7v1oNT4", name: "Jackson (Pro)", description: "ElevenLabs, Movie Style Narration", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "p2ueywPKFXYa6hdYfSIJ", name: "Tyler (Pro)", description: "ElevenLabs, US Male Friendly", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Olivia (Pro)", description: "ElevenLabs, Warm US Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "FUfBrNit0NNZAwb58KWH", name: "Emily (Pro)", description: "ElevenLabs, Conversational US Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "xctasy8XvGp2cVO9HL9k", name: "Sophia (Pro Kid)", description: "ElevenLabs, US Female Young", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "goT3UYdM9bhm0n2lmKQx", name: "James (Pro UK)", description: "ElevenLabs, British Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "19STyYD15bswVz51nqLf", name: "Amelia (Pro UK)", description: "ElevenLabs, British Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "2h7ex7B1yGrkcLFI8zUO", name: "Pierre (Pro FR)", description: "ElevenLabs, French Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "xNtG3W2oqJs0cJZuTyBc", name: "Claire (Pro FR)", description: "ElevenLabs, French Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "IP2syKL31S2JthzSSfZH", name: "Diego (Pro ES)", description: "ElevenLabs, Spanish Accent Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "WLjZnm4PkNmYtNCyiCq8", name: "Lucia (Pro ES)", description: "ElevenLabs, Spanish Accent Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "zA6D7RyKdc2EClouEMkP", name: "Aimee (ASMR Pro)", description: "Female British Meditation ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true },
  { id: "RCQHZdatZm4oG3N6Nwme", name: "Dr. Lovelace (ASMR Pro)", description: "Pro Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true },
  { id: "RBknfnzK8KHNwv44gIrh", name: "James Whitmore (ASMR Pro)", description: "Gentle Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "male", disabled: true },
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true }
];

// Polly Free Voices (enabled by default)
const pollyVoices = [
  { id: "Matthew", name: "Matthew (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Joey", name: "Joey (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Brian", name: "Brian (British Male)", description: "Amazon Polly, Male, British English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Russell", name: "Russell (Australian Male)", description: "Amazon Polly, Male, Australian English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Joanna", name: "Joanna (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Kimberly", name: "Kimberly (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Amy", name: "Amy (British Female)", description: "Amazon Polly, Female, British English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Salli", name: "Salli (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false }
];

// Combine voices with free voices first, then pro voices (and add preview URLs)
const mappedCustomVoices = [...pollyVoices, ...elevenProVoices].map(v => ({
  ...v,
  preview: getVoicePreviewFile(v.id, v.preview)
}));

app.get('/api/voices', (req, res) => {
  console.log('[11] /api/voices endpoint called.');
  res.json({ success: true, voices: mappedCustomVoices });
});

// ==========================================
// 12. /api/generate-script ENDPOINT (IMPROVED FOR VOICE NARRATION WITH HOOK + LENGTH LIMIT)
// ==========================================
app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  console.log('[12] /api/generate-script endpoint called. idea:', idea);
  if (!idea) {
    console.warn('[12] /api/generate-script: Idea required');
    return res.status(400).json({ success: false, error: 'Idea required' });
  }
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Prompt now asks for a strong hook first line + max 12 lines total (~1 minute)
    const scriptPrompt = `
Generate a YouTube Shorts script for this topic with the following rules:
- The FIRST line must be a curiosity-piquing HOOK sentence (a question or teaser) that makes viewers want to watch, without revealing facts yet.
- After the hook, provide up to 11 more short, punchy, voice-friendly facts or statements related to the topic.
- Total lines should be 12 maximum.
- No emojis, no lists, no numbers, no bullet points, just natural, crisp lines.
- Lines must be short and easy for text-to-speech voices to read.
- No repeating words/phrases, no "as you know", no generic filler.
- Each line must be interesting and unique.
Format (no headers, just raw script, one short line per line):

THEME: ${idea}

SCRIPT:
`.trim();

    const out = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: scriptPrompt }],
      temperature: 0.92,
      max_tokens: 450, // increased for 12 lines
    });

    let script = out.choices[0].message.content
      .replace(/^[\d\-\.\*]+\s*/gm, '')      // clean numbered/bullets if any
      .replace(/\p{Extended_Pictographic}/gu, '') // remove emojis
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2);

    // Enforce max 12 lines in case API returns more
    if (script.length > 12) {
      script = script.slice(0, 12);
      console.log('[12] Script truncated to 12 lines for ~1 minute limit.');
    }

    script = script.join('\n');
    script = stripEmojis(script);

    const { viralTitle, viralDesc, viralTags } = await generateViralMetadata({
      script, topic: idea, oldTitle: '', oldDesc: ''
    });

    console.log('[12] /api/generate-script: Success. Title:', viralTitle);
    return res.json({
      success: true,
      script,
      title: viralTitle,
      description: viralDesc,
      hashtags: viralTags,
      tags: viralTags,
      oldTitle: '',
      oldDesc: ''
    });
  } catch (err) {
    console.error('[12] SCRIPT ERR:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 13. SPARKIE (IDEA GENERATOR) ENDPOINT
// ==========================================
app.post('/api/sparkie', async (req, res) => {
  const { prompt } = req.body;
  console.log('[13] /api/sparkie endpoint called. Prompt:', prompt);
  if (!prompt) {
    console.warn('[13] /api/sparkie: Prompt required');
    return res.status(400).json({ success: false, error: 'Prompt required' });
  }
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const c = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are Sparkie, a creative brainstorming assistant.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.9
    });
    console.log('[13] /api/sparkie: Sparkie ideas generated.');
    return res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch (e) {
    console.error('[13] /api/sparkie error:', e);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
});

// ==========================================
// 14. /api/generate-thumbnails ENDPOINT (VIRAL STYLE THUMBNAIL GENERATOR)
// ==========================================
app.post('/api/generate-thumbnails', async (req, res) => {
  const { topic } = req.body;
  console.log('[14] /api/generate-thumbnails endpoint called. Topic:', topic);
  if (!topic) {
    console.warn('[14] /api/generate-thumbnails: Topic required');
    return res.status(400).json({ success: false, error: 'Topic required' });
  }

  // Viral-style font files stored in /fonts
  const fontFiles = [
    'Impact.ttf',
    'Anton-Regular.ttf',
    'BebasNeue-Regular.ttf',
    'LeagueGothic-Regular.ttf',
    'Oswald-Regular.ttf',
    'Montserrat-Bold.ttf',
    'Poppins-Bold.ttf',
    'Raleway-Black.ttf',
    'Roboto-Bold.ttf',
    'ArchivoBlack-Regular.ttf'
  ];

  // 20 proven viral captions (feel free to add your own, use topic if <10)
  const viralCaptions = [
    `You Won't Believe This!`,
    `What Happens Next Will Shock You`,
    `Top 10 ${topic}`,
    `The Untold Truth About ${topic}`,
    `How ${topic} Changed Everything`,
    `Is This The Future of ${topic}?`,
    `Watch Before It's Deleted`,
    `#1 Reason People Love ${topic}`,
    `They Don't Want You To Know This`,
    `Insane Facts About ${topic}`,
    `The Secret Behind ${topic}`,
    `Are You Ready For This?`,
    `Mind-Blowing ${topic} Facts`,
    `Never Seen Before!`,
    `Only 1% Know This`,
    `This Will Change How You Think`,
    `Warning: Highly Addictive`,
    `Bet You Didn't Know This`,
    `Must See!`,
    `Viral In 24 Hours`
  ];

  try {
    // Register fonts for Canvas
    fontFiles.forEach((font, i) => {
      try {
        registerFont(path.join(__dirname, 'fonts', font), { family: `ViralFont${i}` });
        console.log(`[14] Registered font: ${font}`);
      } catch (err) {
        console.warn(`[14] Could not register font: ${font} —`, err.message);
      }
    });

    // Helper to fetch a truly random image for each thumbnail
    async function fetchRandomImage(i) {
      const q = encodeURIComponent(topic);
      // add ?sig=${i} to force a new image each time
      return `https://source.unsplash.com/1280x720/?${q}&sig=${i}`;
    }

    const canvasWidth = 1280;
    const canvasHeight = 720;
    const thumbnails = [];

    for (let i = 0; i < 10; i++) {
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Get a unique Unsplash image
      const bgUrl = await fetchRandomImage(i);
      try {
        const bgImage = await loadImage(bgUrl);
        ctx.drawImage(bgImage, 0, 0, canvasWidth, canvasHeight);
        console.log(`[14] Loaded background image for thumbnail ${i + 1}`);
      } catch (err) {
        ctx.fillStyle = '#232323';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        console.warn(`[14] Could not load image, used blank for thumbnail ${i + 1}`);
      }

      // Pick a caption (rotate if fewer than 10, random if more)
      const caption =
        viralCaptions.length >= 10
          ? viralCaptions[i % viralCaptions.length].toUpperCase()
          : topic.toUpperCase();

      // Pick a random or rotating font
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'white';
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 8;

      const fontSize = 88;
      ctx.font = `${fontSize}px ViralFont${i % fontFiles.length}`;

      // Draw caption at bottom
      ctx.strokeText(caption, canvasWidth / 2, canvasHeight - 60);
      ctx.fillText(caption, canvasWidth / 2, canvasHeight - 60);

      // Add a small watermark/logo in the bottom corner (optional)
      ctx.font = '38px ViralFont1';
      ctx.globalAlpha = 0.65;
      ctx.fillStyle = '#00eaff';
      ctx.fillText('SocialStormAI', canvasWidth - 230, canvasHeight - 22);
      ctx.globalAlpha = 1;

      // Convert to base64
      const dataUrl = canvas.toDataURL('image/png');
      thumbnails.push(dataUrl);
      console.log(`[14] Thumbnail ${i + 1} generated`);
    }

    console.log('[14] All thumbnails generated successfully.');
    return res.json({ success: true, thumbnails });

  } catch (err) {
    console.error('[14] Thumbnail generator error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ==========================================
// 15. /api/generate-video ENDPOINT (MAIN VIDEO GENERATION LOGIC)
// ==========================================

// --- 1. Helper: ffmpegPromise ---
function ffmpegPromise(setupFn, timeoutMs = 120000, errMsg = 'ffmpegPromise timed out') {
  return new Promise((resolve, reject) => {
    const proc = setupFn();
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill && proc.kill('SIGKILL');
        reject(new Error(errMsg));
      }
    }, timeoutMs);
    proc.on('end', (...a) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(...a); }
    });
    proc.on('error', (e) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    });
  });
}

app.post('/api/generate-video', async (req, res) => {
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  console.log(`[15] /api/generate-video endpoint called. Job ID: ${jobId}`);
  res.json({ jobId });

  (async () => {
    let finished = false;
    let watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
        console.error(`[15][${jobId}] TIMED OUT!`);
      }
    }, 10 * 60 * 1000);

    try {
      const { script, voice, removeWatermark, paidUser } = req.body;
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        console.error(`[15][${jobId}] ERROR: script & voice required`);
        return;
      }

      // === GENERATE VIRAL METADATA FOR ANY SCRIPT (DECOUPLED FROM VIDEO LOGIC) ===
      let viralTitle = '', viralDesc = '', viralTags = '';
      generateViralMetadata({
        script,
        topic: await extractMainSubject(script),
        oldTitle: '',
        oldDesc: ''
      }).then(meta => {
        viralTitle = meta.viralTitle;
        viralDesc = meta.viralDesc;
        viralTags = meta.viralTags;
        progress[jobId].viralTitle = viralTitle;
        progress[jobId].viralDesc = viralDesc;
        progress[jobId].viralTags = viralTags;
      }).catch(metaErr => {
        console.error(`[15][${jobId}] Metadata generation error:`, metaErr);
      });

      // === SPLIT SCRIPT INTO SCENES (STRICTLY SCENE-BASED) ===
      const steps = splitScriptToScenes(script).slice(0, 20); // up to 20 scenes max (~60s)
      const totalSteps = steps.length + 5; // for progress calculation
      let currentStep = 0;

      if (!steps.length) throw new Error('No scenes found in script.');

      // === INIT DIRECTORIES, TRACKERS ===
      const workDir = path.join(__dirname, 'tmp', uuidv4());
      fs.mkdirSync(workDir, { recursive: true });
      const scenes = [];

      // Used clips tracking to prevent repeats
      const usedClipPaths = [];

      // --- Helper: synthesize TTS with Polly or ElevenLabs ---
      async function synthesizeTTS(text, voiceId, outFile) {
        const pollyVoiceIds = pollyVoices.map(v => v.id);
        if (pollyVoiceIds.includes(voiceId)) {
          const params = {
            Text: text,
            OutputFormat: "mp3",
            VoiceId: voiceId,
            Engine: "standard"
          };
          try {
            const data = await polly.synthesizeSpeech(params).promise();
            if (!data.AudioStream) throw new Error('No AudioStream from Polly');
            await fs.promises.writeFile(outFile, data.AudioStream);
            console.log(`[15][${jobId}] Polly TTS done for: "${text}"`);
          } catch (err) {
            console.error(`[15][${jobId}] Polly TTS error:`, err);
            throw new Error(`Polly TTS error: ${err.message}`);
          }
        } else {
          try {
            const ttsRes = await axios.post(
              `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
              { text, model_id: 'eleven_monolingual_v1' },
              { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
            );
            fs.writeFileSync(outFile, ttsRes.data);
            console.log(`[15][${jobId}] ElevenLabs TTS done for: "${text}"`);
          } catch (err) {
            console.error(`[15][${jobId}] ElevenLabs TTS error:`, err);
            throw new Error(`ElevenLabs TTS error: ${err.message}`);
          }
        }
      }

      // ========== MAIN SCENE-BY-SCENE LINEAR LOOP ==========
      for (let i = 0; i < steps.length; i++) {
        const sceneText = steps[i].trim();
        try {
          currentStep++;
          progress[jobId] = {
            percent: Math.round((currentStep / totalSteps) * 100),
            status: `Building scene ${i + 1}/${steps.length}`,
            viralTitle, viralDesc, viralTags
          };
          console.log(`[15][${jobId}] ===== Scene ${i + 1}/${steps.length} START =====`);
          console.log(`[15][${jobId}] Scene text: "${sceneText}"`);

          // --- 1. Generate TTS audio for this scene ---
          const audioPath = path.join(workDir, `scene-${i + 1}.mp3`);
          await synthesizeTTS(sceneText, voice, audioPath);
          console.log(`[15][${jobId}] Scene ${i + 1} TTS audio generated: ${audioPath}`);

          // --- 2. Find best-available video clip for this scene, excluding used ones ---
          const pickResult = await findBestClipForScene(sceneText, workDir, usedClipPaths);
          if (!pickResult) {
            throw new Error(`No video clip found for scene: "${sceneText}" (even after all sources)`);
          }
          const clipPath = pickResult;
          console.log(`[15][${jobId}] Scene ${i + 1} video clip selected: ${clipPath}`);

          // Track used clips to avoid repeats
          usedClipPaths.push(clipPath);

          // --- 3. Combine audio & video into a scene file ---
          const sceneOutPath = path.join(workDir, `scene-${i + 1}.mp4`);
          await ffmpegPromise(() =>
            ffmpeg()
              .input(clipPath)
              .input(audioPath)
              .outputOptions([
                '-c:v libx264', '-preset veryfast', '-crf 22',
                '-map 0:v:0', '-map 1:a:0',
                '-shortest', '-y'
              ])
              .save(sceneOutPath)
          );
          console.log(`[15][${jobId}] Scene ${i + 1} mp4 built: ${sceneOutPath}`);

          scenes.push(sceneOutPath);
          console.log(`[15][${jobId}] ===== Scene ${i + 1}/${steps.length} COMPLETE =====`);
        } catch (err) {
          console.error(`[15][${jobId}] Scene ${i + 1} error:`, err);
          progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
          cleanupJob(jobId, 10 * 1000);
          finished = true;
          clearTimeout(watchdog);
          return;
        }
      }

      // ========== CONCAT ALL SCENES TO FINAL VIDEO ==========
      try {
        currentStep++;
        progress[jobId] = {
          percent: Math.round((currentStep / totalSteps) * 100),
          status: "Stitching scenes together...",
          viralTitle, viralDesc, viralTags
        };
        console.log(`[15][${jobId}] Concatenating ${scenes.length} scenes...`);

        const concatListPath = path.join(workDir, "concat.txt");
        fs.writeFileSync(concatListPath, scenes.map(s => `file '${s}'`).join('\n'));

        const stitchedVideoPath = path.join(workDir, 'final-stitched.mp4');
        await ffmpegPromise(() =>
          ffmpeg()
            .input(concatListPath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy', '-y'])
            .save(stitchedVideoPath)
        );
        console.log(`[15][${jobId}] Scenes stitched: ${stitchedVideoPath}`);

        // --- TODO: Add outro, watermark, overlays here if needed ---

        // ========== UPLOAD TO R2 ==========
        currentStep++;
        progress[jobId] = {
          percent: Math.round((currentStep / totalSteps) * 100),
          status: "Uploading final video...",
          viralTitle, viralDesc, viralTags
        };
        const r2Key = `videos/${jobId}.mp4`;
        await uploadFileToR2(stitchedVideoPath, r2Key);
        console.log(`[15][${jobId}] Video uploaded to R2 as: ${r2Key}`);

        progress[jobId] = {
          percent: 100,
          status: "Done",
          key: r2Key,
          viralTitle, viralDesc, viralTags
        };

        cleanupJob(jobId, 90 * 1000);
        finished = true;
        clearTimeout(watchdog);
        console.log(`[15][${jobId}] VIDEO JOB COMPLETE`);
      } catch (err) {
        console.error(`[15][${jobId}] Final concat/upload error:`, err);
        progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
        cleanupJob(jobId, 60 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }

    } catch (e) {
      console.error(`[15][${jobId}] Fatal error in video generator:`, e);
      progress[jobId] = { percent: 100, status: "Failed: " + e.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      return;
    }
  })();
});



// ==========================================
// 16. PROGRESS POLLING ENDPOINT
// ==========================================
app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = progress[jobId];
  if (!job) {
    console.warn('[16] /api/progress: Job not found or expired for', jobId);
    return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  }
  console.log('[16] /api/progress:', jobId, job);
  res.json(job);
});

// ==========================================
// 17. GENERATE VOICE PREVIEWS ENDPOINT
// ==========================================
app.post('/api/generate-voice-previews', async (req, res) => {
  const sampleText = "This is a sample of my voice.";
  console.log('[17] /api/generate-voice-previews endpoint called.');
  try {
    for (const v of pollyVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `sample_${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithPolly(sampleText, v.id, filePath);
        console.log("[17] Generated preview for Polly voice:", v.name);
      } else {
        console.log("[17] Polly voice preview exists:", v.name);
      }
    }
    for (const v of elevenProVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithElevenLabs(sampleText, v.id, filePath);
        console.log("[17] Generated preview for ElevenLabs voice:", v.name);
      } else {
        console.log("[17] ElevenLabs voice preview exists:", v.name);
      }
    }
    res.json({ success: true, message: "Voice previews generated." });
  } catch (err) {
    console.error("[17] Voice preview generation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ==========================================
// 18. SERVE VIDEOS FROM CLOUDFLARE R2 (STREAMING, DOWNLOAD, RANGE SUPPORT)
// ==========================================
app.get('/video/videos/:key', async (req, res) => {
  const keyParam = req.params.key;
  const key = `videos/${keyParam}`;
  console.log(`[18] /video/videos/:key endpoint called. Key: ${key}`);
  try {
    const headData = await s3.headObject({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }).promise();
    const total = headData.ContentLength;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log(`[18] Video size: ${total} bytes. Range: ${range ? range : 'none'}`);

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      const chunkSize = (end - start) + 1;

      const stream = s3.getObject({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Range: `bytes=${start}-${end}`
      }).createReadStream();

      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize,
        "Content-Type": "video/mp4",
        "Access-Control-Expose-Headers": "Content-Disposition"
      });

      stream.on('error', (err) => {
        console.error("[18] R2 video stream error (range):", err);
        if (!res.headersSent) res.status(404).end('Video not found');
      });

      stream.pipe(res);
      console.log(`[18] Streaming range: ${start}-${end}`);
    } else {
      const stream = s3.getObject({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }).createReadStream();

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
      res.setHeader('Content-Length', total);

      stream.on('error', (err) => {
        console.error("[18] R2 video stream error (full):", err);
        if (!res.headersSent) res.status(404).end('Video not found');
      });

      stream.pipe(res);
      console.log(`[18] Streaming full video: ${key}`);
    }
  } catch (err) {
    console.error("[18] Video route error:", err);
    if (!res.headersSent) res.status(500).end('Internal error');
  }
});

// ==========================================
// 19. PRETTY URLs FOR .HTML PAGES
// ==========================================
app.get('/*.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
  console.log(`[19] Pretty HTML requested: ${req.path}, resolved to: ${htmlPath}`);
  if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
    res.sendFile(htmlPath);
    console.log(`[19] Sent HTML file: ${htmlPath}`);
  } else {
    console.warn(`[19] HTML file not found: ${htmlPath}`);
    res.status(404).send('Not found');
  }
});

// ==========================================
// 20. 404 HTML FALLBACK FOR SPA (NOT API)
// ==========================================
app.get('*', (req, res) => {
  console.log(`[20] Fallback route hit: ${req.path}`);
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/video/')) {
    const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
    if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
      res.sendFile(htmlPath);
      console.log(`[20] Sent fallback HTML file: ${htmlPath}`);
    } else {
      const fallback = path.join(__dirname, 'frontend', 'index.html');
      res.sendFile(fallback);
      console.log(`[20] Sent index.html as fallback.`);
    }
  } else {
    res.status(404).json({ error: 'Not found.' });
    console.warn(`[20] Not found for API or video route: ${req.path}`);
  }
});

// ==========================================
// 21. LAUNCH SERVER
// ==========================================
app.listen(PORT, '0.0.0.0', () =>
  console.log(`[21] 🚀 Server listening on port ${PORT} (http://localhost:${PORT})`)
);

// ==========================================
// END OF FILE
// ==========================================
