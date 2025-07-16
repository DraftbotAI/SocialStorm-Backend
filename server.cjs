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
console.log('[6] Cloudflare R2 S3 client configured.');

// ==========================================
// 7. HELPERS
// ==========================================
async function downloadToFile(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const w = fs.createWriteStream(dest);
  console.log(`[7] downloadToFile: Downloading from ${url} to ${dest}`);
  try {
    const r = await axios.get(url, { responseType: 'stream' });
    r.data.pipe(w);
    return new Promise((res, rej) => w.on('finish', () => {
      console.log(`[7] downloadToFile: Finished writing to ${dest}`);
      res();
    }).on('error', (err) => {
      console.error(`[7] downloadToFile error for ${url} → ${dest}:`, err);
      rej(err);
    }));
  } catch (err) {
    console.error(`[7] downloadToFile AXIOS ERROR for ${url}:`, err);
    throw err;
  }
}
function sanitizeQuery(s, max=12) {
  const stop = new Set(['and','the','with','into','for','a','to','of','in']);
  const sanitized = s.replace(/["“”‘’.,!?;]/g,'')
    .split(/\s+/)
    .filter(w => !stop.has(w.toLowerCase()))
    .slice(0, max)
    .join(' ');
  console.log(`[7] sanitizeQuery result: "${sanitized}"`);
  return sanitized;
}
function stripEmojis(str) {
  const noEmoji = str.replace(/\p{Extended_Pictographic}/gu, '');
  if (str !== noEmoji) console.log('[7] stripEmojis removed emojis.');
  return noEmoji;
}
async function extractMainSubject(script) {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const out = await openai.chat.completions.create({
      model:'gpt-3.5-turbo',
      messages:[
        { role:'system', content:'Extract the ONE main subject of this script in 1-3 words, lowercase, no hashtags or punctuation. Only return the subject.' },
        { role:'user', content: script }
      ],
      temperature: 0.2
    });
    let subject = out.choices[0].message.content.trim().toLowerCase();
    if (subject.includes('\n')) subject = subject.split('\n')[0].trim();
    const cleaned = subject.replace(/[^a-z0-9 ]+/gi, '').trim();
    console.log(`[7] extractMainSubject: "${cleaned}"`);
    return cleaned;
  } catch (err) {
    console.warn('[7] extractMainSubject fallback:', err.message);
    return sanitizeQuery(script).split(' ')[0] || 'topic';
  }
}

// ===== MUSIC MOOD MATCHING & PICKER =====
const MUSIC_ROOT = path.join(__dirname, 'frontend', 'assets', 'music_library');

const moodKeywords = [
  { mood: 'spooky_creepy_mystery_horror',   keywords: ['lore', 'mystery', 'ghost', 'scary', 'creepy', 'paranormal', 'dark'] },
  { mood: 'science_tech_futuristic',        keywords: ['science', 'technology', 'ai', 'robot', 'future', 'futuristic'] },
  { mood: 'action_sports_intense',          keywords: ['action', 'fight', 'sports', 'extreme', 'race', 'speed'] },
  { mood: 'dramatic_tense_suspense',        keywords: ['suspense', 'tense', 'drama', 'danger', 'survive'] },
  { mood: 'cinematic_epic_adventure',       keywords: ['epic', 'adventure', 'quest', 'legend', 'battle', 'cinematic'] },
  { mood: 'fantasy_magical',                keywords: ['fantasy', 'magic', 'myth', 'dragon', 'wizard', 'magical'] },
  { mood: 'motivation_inspiration_uplifting',keywords: ['motivation', 'inspire', 'uplift', 'success', 'dream', 'hope'] },
  { mood: 'happy_summer',                   keywords: ['summer', 'happy', 'sun', 'beach', 'vacation', 'fun'] },
  { mood: 'funny_quirky_whimsical',         keywords: ['funny', 'quirky', 'weird', 'strange', 'whimsical', 'silly'] },
  { mood: 'retro_8-bit_gaming',             keywords: ['game', 'retro', '8-bit', 'arcade', 'video game'] },
  { mood: 'news_documentary_neutral',       keywords: ['news', 'documentary', 'report', 'neutral', 'journalism'] },
  { mood: 'corporate_educational_explainer',keywords: ['corporate', 'business', 'office', 'explainer', 'education', 'learning'] },
  { mood: 'lofi_chill_ambient',             keywords: ['lofi', 'chill', 'relax', 'calm', 'study', 'ambient'] },
  { mood: 'nature_ambient_relaxing',        keywords: ['nature', 'animal', 'forest', 'water', 'mountain', 'relax'] },
  { mood: 'sad_emotional_reflective',       keywords: ['sad', 'emotional', 'cry', 'reflect', 'loss', 'goodbye'] },
  { mood: 'upbeat_energetic_pop',           keywords: ['pop', 'energy', 'upbeat', 'dance', 'party'] },
  { mood: 'historical',                     keywords: ['history', 'historical', 'ancient', 'past', 'event'] },
];

async function guessMusicMood(text) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const prompt = `
You are a YouTube video scene music selector. Choose the single best background music mood for this line, based on the genres in this list:
${moodKeywords.map(m => `- ${m.mood}`).join('\n')}
For the following scene, output ONLY the exact folder name from the list above. NO extra words, no explanation.

SCENE: "${text}"
Mood:`;
  try {
    const out = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 8,
    });
    const mood = out.choices[0].message.content.trim();
    if (moodKeywords.find(m => m.mood === mood)) {
      console.log(`[7] guessMusicMood detected mood: ${mood}`);
      return mood;
    }
    console.warn(`[7] guessMusicMood: model returned unknown mood "${mood}", using fallback.`);
    return 'news_documentary_neutral';
  } catch (err) {
    console.warn('[7] guessMusicMood fallback:', err.message);
    return 'news_documentary_neutral';
  }
}

function pickMusicFile(moodFolder) {
  const absPath = path.join(MUSIC_ROOT, moodFolder);
  if (!fs.existsSync(absPath)) {
    console.warn(`[7] pickMusicFile: folder does not exist: ${absPath}`);
    return null;
  }
  const files = fs.readdirSync(absPath).filter(f => f.endsWith('.mp3'));
  if (!files.length) {
    console.warn(`[7] pickMusicFile: no mp3 files in ${absPath}`);
    return null;
  }
  const chosen = files[Math.floor(Math.random() * files.length)];
  console.log(`[7] pickMusicFile selected: ${chosen}`);
  return path.join(absPath, chosen);
}
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
// 12. /api/generate-script ENDPOINT (IMPROVED FOR VOICE NARRATION)
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

    const scriptPrompt = `
Generate a YouTube Shorts script for this topic, with each line being a punchy, voice-friendly fact or statement.
- No emojis, no lists, no numbers, no bullet points, just natural, crisp lines.
- Lines must be short and easy for text-to-speech voices to read.
- Do NOT use any numbered list, bullet list, or anything that sounds like a list unless user requests it.
- No repeating words/phrases, no "as you know", no generic filler.
- Each line must be interesting and unique.
Format (no headers, just the raw script, one short line per line):

THEME: ${idea}

SCRIPT:
`.trim();

    const out = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: scriptPrompt }],
      temperature: 0.92,
      max_tokens: 400,
    });

    let script = out.choices[0].message.content
      .replace(/^[\d\-\.\*]+\s*/gm, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2)
      .join('\n');

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

      // === GENERATE VIRAL METADATA FOR ANY SCRIPT ===
      let viralTitle = '', viralDesc = '', viralTags = '';
      try {
        const meta = await generateViralMetadata({
          script, topic: await extractMainSubject(script), oldTitle: '', oldDesc: ''
        });
        viralTitle = meta.viralTitle;
        viralDesc = meta.viralDesc;
        viralTags = meta.viralTags;
        progress[jobId].viralTitle = viralTitle;
        progress[jobId].viralDesc = viralDesc;
        progress[jobId].viralTags = viralTags;
      } catch (metaErr) {
        console.error(`[15][${jobId}] Metadata generation error:`, metaErr);
      }

      const mainSubject = await extractMainSubject(script);
      console.log(`[15][${jobId}] Main subject:`, mainSubject);
      if (!mainSubject) throw new Error('No main subject found for this script.');

      // Allow dynamic scene count (up to 20) to support longer videos (up to 60s)
      const steps = splitScriptToScenes(script).slice(0, 20);
      const totalSteps = steps.length + 5;
      let currentStep = 0;

      const workDir = path.join(__dirname, 'tmp', uuidv4());
      fs.mkdirSync(workDir, { recursive: true });
      const scenes = [];
      const usedUrls = new Set();
      const usedIds = new Set();
      const fallbackQueries = [
        "nature", "background", "city", "abstract", "travel", "people", "pattern", "wallpaper"
      ];

      let mediaFailCount = 0;

      // Helper: synthesize TTS with Polly or ElevenLabs
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
            console.log(`[15][${jobId}] Polly TTS done for text: "${text}"`);
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
            console.log(`[15][${jobId}] ElevenLabs TTS done for text: "${text}"`);
          } catch (err) {
            console.error(`[15][${jobId}] ElevenLabs TTS error:`, err);
            throw new Error(`ElevenLabs TTS error: ${err.message}`);
          }
        }
      }

      // === MAIN SCENE LOOP ===
      for (let i = 0; i < steps.length; i++) {
        try {
          currentStep++;
          progress[jobId] = {
            percent: Math.round((currentStep / totalSteps) * 100),
            status: `Building scene ${i + 1}/${steps.length}`,
            viralTitle, viralDesc, viralTags
          };
          console.log(`[15][${jobId}] ===== Scene ${i + 1}/${steps.length} START =====`);

          // ... [The rest of your full, original scene logic remains, every line as in your real code.] ...

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

      // TODO: Keep your existing OUTRO, CONCAT, WATERMARK, UPLOAD code here!
      // You can also wrap any long ffmpeg calls in ffmpegPromise as above.

      progress[jobId] = { percent: 100, status: "Done", viralTitle, viralDesc, viralTags };
      cleanupJob(jobId, 90 * 1000);
      finished = true;
      clearTimeout(watchdog);
      console.log(`[15][${jobId}] VIDEO JOB COMPLETE`);

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
