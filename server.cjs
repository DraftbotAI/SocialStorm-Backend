// ==========================================
// 1. CANVAS & JSZIP IMPORTS (Used for thumbnails/zips if needed)
// ==========================================
const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');
console.log('[1] Canvas and JSZip modules loaded.');

// ==========================================
// 2. DIRECTORY DEBUGGING (DEV ONLY)
// ==========================================
const fs = require('fs');
const path = require('path');
console.log('[2] Working directory:', __dirname);
console.log('[2] Files/folders here:', fs.readdirSync(__dirname));
if (fs.existsSync(path.join(__dirname, 'frontend'))) {
  console.log('[2] Frontend folder contents:', fs.readdirSync(path.join(__dirname, 'frontend')));
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
const { v4: uuidv4 } = require('uuid');
const AWS            = require('aws-sdk');
const ffmpegPath     = require('ffmpeg-static');
const ffmpeg         = require('fluent-ffmpeg');
const stringSimilarity = require('string-similarity');
const { OpenAI }     = require('openai');
let openai;
try {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[3] ⚠️ No OPENAI_API_KEY set in environment!');
  }
} catch (e) {
  console.error('[3] OpenAI init failed:', e);
}
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
  console.log(`[5] [${new Date().toISOString()}] ${req.method} ${req.url} — body:`, JSON.stringify(req.body || {}));
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
// 7. HELPERS, VOICES, AND LOGGING (INLINE, FULLY MODULAR)
// ==========================================

// === String & subject helpers ===
function stripEmojis(str) {
  if (!str) return '';
  return str.replace(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDD00-\uDDFF])/g, '');
}
function sanitizeQuery(str) {
  if (!str) return '';
  return str.replace(/[^a-zA-Z0-9 ]/g, '').toLowerCase();
}
function extractMainSubject(script) {
  if (!script || typeof script !== "string") return "video";
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.split(' ').length > 1 && !/^(did you know|here|welcome|let's)/i.test(line)) {
      return line.replace(/[.?!]$/, '');
    }
  }
  return "video";
}

// === FULL CLIP LOGIC: R2, PEXELS, PIXABAY, LOCAL FALLBACK ===
async function getR2ClipList(safe = false) {
  try {
    const { Contents } = await s3.listObjectsV2({
      Bucket: process.env.R2_BUCKET,
      Prefix: 'clips/'
    }).promise();
    const list = (Contents || []).map(obj => obj.Key).filter(Boolean);
    if (!list.length) throw new Error("No clips in R2");
    console.log(`[7] getR2ClipList: Found ${list.length} in R2`);
    return list;
  } catch (err) {
    if (!safe) throw err;
    console.warn('[7] getR2ClipList error:', err);
    return [];
  }
}
async function downloadFromR2ToFile(r2Key, dest) {
  try {
    const { Body } = await s3.getObject({
      Bucket: process.env.R2_BUCKET,
      Key: r2Key
    }).promise();
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, Body);
    console.log(`[7] R2 clip downloaded: ${r2Key} -> ${dest}`);
    return dest;
  } catch (err) {
    console.warn(`[7] downloadFromR2ToFile failed: ${err.message}`);
    return null;
  }
}

// TODO: Inline your Pexels/Pixabay logic here if you want that live in the file

async function findBestClipForScene(sceneText, workDir, usedClips = []) {
  // 1. R2 Cloudflare search (fuzzy match)
  try {
    const clipList = await getR2ClipList(true);
    const names = clipList.map(key => key.toLowerCase());
    const mainSubject = extractMainSubject(sceneText);
    const keywords = [mainSubject, ...sanitizeQuery(sceneText).split(' ').slice(0,2), 'nature', 'animal', 'background'];
    for (let kw of keywords) {
      const best = stringSimilarity.findBestMatch(kw.toLowerCase(), names);
      if (best.bestMatch.rating > 0.28) {
        const key = clipList[best.bestMatchIndex];
        if (usedClips.includes(key)) continue;
        const localDest = path.join(workDir, path.basename(key));
        await downloadFromR2ToFile(key, localDest);
        console.log(`[7] findBestClipForScene: Using R2 clip: ${key}`);
        return localDest;
      }
    }
  } catch (err) {
    console.warn(`[7] R2 search failed: ${err.message}`);
  }
  // 2. Local fallback (if no cloud)
  try {
    const localFallbackDir = path.join(__dirname, 'clips');
    if (fs.existsSync(localFallbackDir)) {
      const files = fs.readdirSync(localFallbackDir).filter(f => f.endsWith('.mp4'));
      if (files.length) {
        const chosen = files[Math.floor(Math.random() * files.length)];
        console.log(`[7] findBestClipForScene: Using local fallback: ${chosen}`);
        return path.join(localFallbackDir, chosen);
      }
    }
  } catch (err) {
    console.warn(`[7] Local fallback search failed: ${err.message}`);
  }
  // 3. Final fail
  console.error(`[7] findBestClipForScene: FAILED for scene: "${sceneText}"`);
  return null;
}

// ========== ALL VOICES (FULL) ==========
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
console.log('[7] All helper utilities and voices defined.');
// ==========================================
// 8. VIRAL METADATA ENGINE (FULL LOGGING)
// ==========================================
async function generateViralMetadata(script) {
  try {
    if (!openai || !process.env.OPENAI_API_KEY) {
      console.warn("[8] OpenAI API not configured, returning fallback metadata.");
      return {
        title: "Viral Video",
        description: "Watch this amazing video generated with SocialStormAI.",
        tags: "#viral #shorts #ai"
      };
    }
    const metaPrompt = `
You are a YouTube Shorts expert. Given this script, write:
1. Viral clickable TITLE (max 62 chars)
2. Two-sentence DESCRIPTION, SEO, no hashtags/emojis
3. 14-18 trending HASHTAGS for YouTube Shorts, comma separated (#catfacts, #viral, etc)

SCRIPT:
${script}

Respond in this format:
TITLE: [title]
DESCRIPTION: [description]
HASHTAGS: [hashtags]
    `.trim();

    console.log("[8] Requesting viral metadata from OpenAI...");
    const out = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: metaPrompt }],
      temperature: 0.92,
      max_tokens: 360
    });

    const text = out.choices[0].message.content.trim();
    const title = (text.match(/TITLE:\s*(.+)\s*DESCRIPTION:/is) || [])[1]?.trim() || "Viral Video";
    const description = (text.match(/DESCRIPTION:\s*([\s\S]+?)HASHTAGS:/is) || [])[1]?.replace(/\s+/g, " ").trim() || "";
    const tags = (text.match(/HASHTAGS:\s*(.+)$/i) || [])[1]?.replace(/\s+/g, "") || "#viral,#shorts";
    console.log("[8] Metadata from OpenAI:", { title, description, tags });
    return {
      title: stripEmojis(title).slice(0, 62),
      description: stripEmojis(description).slice(0, 200),
      tags: tags.split(",").map(t => t.startsWith("#") ? t : "#" + t).filter(Boolean).join(", ")
    };
  } catch (err) {
    console.error("[8] Viral metadata fallback, error:", err.message);
    return {
      title: "Viral Video",
      description: "Watch this amazing video generated with SocialStormAI.",
      tags: "#viral #shorts #ai"
    };
  }
}

// ==========================================
// 9. SCRIPT-TO-SCENES SPLITTER (FULL LOGGING)
// ==========================================
function splitScriptToScenes(script) {
  const scenes = (script || "")
    .split(/(?<=[.!?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
  console.log(`[9] splitScriptToScenes: Split into ${scenes.length} scenes`);
  return scenes;
}

// ==========================================
// 10. ELEVENLABS & POLLY TTS SYNTHESIZER (FULL LOGGING)
// ==========================================
async function synthesizeWithElevenLabs(text, voice, outFile) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("No ElevenLabs API Key");
    console.log(`[10] synthesizeWithElevenLabs: "${voice}" => ${outFile} | Text: "${text}"`);
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      { text, model_id: "eleven_monolingual_v1" },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, responseType: "arraybuffer" }
    );
    fs.writeFileSync(outFile, ttsRes.data);
    console.log(`[10] ElevenLabs audio written: ${outFile}`);
    return outFile;
  } catch (err) {
    console.error("[10] ElevenLabs error:", err.message);
    throw new Error("ElevenLabs error: " + err.message);
  }
}

async function synthesizeWithPolly(text, voice, outFile) {
  const params = {
    Text: text,
    OutputFormat: "mp3",
    VoiceId: voice,
    Engine: "neural"
  };
  console.log(`[10] synthesizeWithPolly: "${voice}" => ${outFile} | Text: "${text}"`);
  return new Promise((resolve, reject) => {
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        console.error("[10] Polly error:", err.message);
        return reject(new Error("Polly error: " + err.message));
      }
      if (data && data.AudioStream instanceof Buffer) {
        fs.writeFileSync(outFile, data.AudioStream);
        console.log(`[10] Polly audio written: ${outFile}`);
        resolve(outFile);
      } else {
        reject(new Error("Polly synthesis failed, no audio stream."));
      }
    });
  });
}

// ==========================================
// 11. /api/voices ENDPOINT (FULL LOGGING)
// ==========================================
app.get('/api/voices', (req, res) => {
  console.log("[11] /api/voices endpoint called.");
  const mappedCustomVoices = [...pollyVoices, ...elevenProVoices];
  res.json({ success: true, voices: mappedCustomVoices });
});

// ==========================================
// 12. /api/generate-script ENDPOINT
// ==========================================
app.post('/api/generate-script', async (req, res) => {
  console.log("[12] /api/generate-script endpoint called.");
  const ideaRaw = req.body.idea;
  if (typeof ideaRaw !== "string" || !ideaRaw.trim()) {
    console.warn("[12] Invalid or missing 'idea' parameter.");
    return res.status(400).json({ success: false, error: "Invalid or missing 'idea' parameter." });
  }
  const idea = ideaRaw.trim();
  try {
    if (!openai || !process.env.OPENAI_API_KEY) {
      console.error("[12] OpenAI unavailable.");
      return res.status(503).json({ success: false, error: "OpenAI unavailable." });
    }

    // FORCE hook in first line, no numbers, no quotes
    const hookPrompt = `
Write a viral short-form video script for the topic: "${idea}".
Rules:
- The FIRST sentence must introduce the topic in a punchy, curiosity-driven way.
- DO NOT use "Line 1", "Line 2", or any line numbers.
- DO NOT add quotes around the lines.
- Each sentence must be on its own line.
- Start with a strong hook sentence.
- Keep it punchy, engaging, and suitable for TikTok or YouTube Shorts.
- Limit the script to under 60 seconds total.
Format (NO numbering or quotes):

Your first punchy sentence here.
Next sentence here.
Another punchy line.
Final sentence.
`.trim();

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You write punchy short-form video scripts for social media." },
        { role: "user", content: hookPrompt }
      ],
      temperature: 0.88,
      max_tokens: 500,
      n: 1,
    });

    let script = response.choices[0].message.content.trim();

    // STRIP line numbers and quotes from each line, but KEEP strong opener
    let scriptLines = script.split(/\r?\n/).map(line =>
      line.replace(/^line\s*\d+[:\-\.]?\s*/i, '')
          .replace(/^["']|["']$/g, '')
          .trim()
    ).filter(line => line.length > 0);

    // If the first line is somehow NOT a hook, keep as is — you want it!
    script = scriptLines.join('\n');

    const viralMeta = await generateViralMetadata(script);
    console.log("[12] Script generated:", script);
    console.log("[12] Metadata:", viralMeta);

    return res.json({
      success: true,
      script,
      title: viralMeta.title,
      description: viralMeta.description,
      tags: viralMeta.tags
    });
  } catch (error) {
    console.error("[12] Error generating script:", error);
    return res.status(500).json({ success: false, error: "Failed to generate script. Try again." });
  }
});

// ==========================================
// 13. SPARKIE (IDEA GENERATOR) ENDPOINT (FULL LOGGING)
// ==========================================
app.post('/api/sparkie', async (req, res) => {
  console.log("[13] /api/sparkie endpoint called.");
  const { prompt } = req.body;
  if (!prompt) {
    console.warn("[13] Prompt required.");
    return res.status(400).json({ success: false, error: 'Prompt required' });
  }
  try {
    if (!openai || !process.env.OPENAI_API_KEY) throw new Error("OpenAI unavailable");
    const c = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are Sparkie, a creative brainstorming assistant.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.92
    });
    console.log("[13] Sparkie ideas generated:", c.choices[0].message.content.trim());
    return res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch (e) {
    console.error("[13] Sparkie error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// 14. /api/generate-thumbnails ENDPOINT (FULL LOGGING)
// ==========================================
app.post('/api/generate-thumbnails', async (req, res) => {
  console.log("[14] /api/generate-thumbnails endpoint called.");
  const { topic } = req.body;
  if (!topic) {
    console.warn("[14] Topic required.");
    return res.status(400).json({ success: false, error: 'Topic required' });
  }

  // Use topic and add font/caption
  const fontFiles = [
    'Impact.ttf','Anton-Regular.ttf','BebasNeue-Regular.ttf','LeagueGothic-Regular.ttf','Oswald-Regular.ttf','Montserrat-Bold.ttf','Poppins-Bold.ttf','Raleway-Black.ttf','Roboto-Bold.ttf','ArchivoBlack-Regular.ttf'
  ];
  fontFiles.forEach((font, i) => {
    try { registerFont(path.join(__dirname, 'fonts', font), { family: `ViralFont${i}` }); }
    catch (err) { console.warn(`[14] Could not register font: ${font}`); }
  });
  const canvasWidth = 1280, canvasHeight = 720, thumbnails = [];
  for (let i = 0; i < 10; i++) {
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = `88px ViralFont${i % fontFiles.length}`; ctx.textAlign = 'center'; ctx.fillStyle = 'white';
    ctx.fillText(topic.toUpperCase(), canvasWidth/2, canvasHeight - 100);
    ctx.font = '32px ViralFont1'; ctx.globalAlpha = 0.7; ctx.fillStyle = '#00eaff';
    ctx.fillText('SocialStormAI', canvasWidth - 200, canvasHeight - 30); ctx.globalAlpha = 1;
    thumbnails.push(canvas.toDataURL('image/png'));
    console.log(`[14] Generated thumbnail ${i + 1} for topic "${topic}"`);
  }
  return res.json({ success: true, thumbnails });
});
// ==========================================
// 15. /api/generate-video ENDPOINT (FULL LOGGING, BULLETPROOF)
// ==========================================
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
  console.log("[15] /api/generate-video endpoint called.");
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
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
      const { script, voice } = req.body;
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        console.error(`[15][${jobId}] ERROR: script & voice required`);
        return;
      }

      // Metadata: always generated, never blocks video creation
      let viralTitle = '', viralDesc = '', viralTags = '';
      try {
        const meta = await generateViralMetadata(script);
        viralTitle = meta.title;
        viralDesc = meta.description;
        viralTags = meta.tags;
        console.log(`[15][${jobId}] Metadata:`, { viralTitle, viralDesc, viralTags });
      } catch (metaErr) {
        console.warn(`[15][${jobId}] Metadata error: ${metaErr.message}`);
      }
      progress[jobId].viralTitle = viralTitle;
      progress[jobId].viralDesc  = viralDesc;
      progress[jobId].viralTags  = viralTags;

      const steps = splitScriptToScenes(script).slice(0, 20);
      const totalSteps = steps.length + 5;
      let currentStep = 0;

      if (!steps.length) {
        console.error(`[15][${jobId}] No scenes found in script.`);
        throw new Error('No scenes found in script.');
      }

      const workDir = path.join(__dirname, 'tmp', uuidv4());
      fs.mkdirSync(workDir, { recursive: true });
      const scenes = [];
      const usedClipPaths = [];

      // --- SCENE LOOP ---
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

          // --- 1. TTS (Polly/ElevenLabs) ---
          const audioPath = path.join(workDir, `scene-${i + 1}.mp3`);
          if (pollyVoices.map(v => v.id).includes(voice)) {
            await synthesizeWithPolly(sceneText, voice, audioPath);
          } else {
            await synthesizeWithElevenLabs(sceneText, voice, audioPath);
          }
          console.log(`[15][${jobId}] Scene ${i + 1} TTS audio generated: ${audioPath}`);

          // --- 2. Pick video clip (fallback to blank) ---
          let clipPath = await findBestClipForScene(sceneText, workDir, usedClipPaths);
          if (!clipPath) {
            // Fallback to a 2s black video (will be created if missing)
            clipPath = path.join(__dirname, 'assets', 'blank.mp4');
            if (!fs.existsSync(clipPath)) {
              await ffmpegPromise(() =>
                ffmpeg()
                  .input('color=black:s=1280x720:d=2')
                  .inputFormat('lavfi')
                  .outputOptions(['-c:v libx264', '-t 2', '-pix_fmt yuv420p'])
                  .save(clipPath)
              );
            }
            console.warn(`[15][${jobId}] No matching clip, used blank.`);
          }
          usedClipPaths.push(clipPath);
          console.log(`[15][${jobId}] Scene ${i + 1} video clip selected: ${clipPath}`);

          // --- 3. Combine audio & video into scene file ---
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
          scenes.push(sceneOutPath);
          console.log(`[15][${jobId}] Scene ${i + 1} mp4 built: ${sceneOutPath}`);
          console.log(`[15][${jobId}] ===== Scene ${i + 1}/${steps.length} COMPLETE =====`);
        } catch (err) {
          progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
          cleanupJob(jobId, 10 * 1000);
          finished = true;
          clearTimeout(watchdog);
          console.error(`[15][${jobId}] Scene ${i + 1} error:`, err);
          return;
        }
      }

      // --- CONCAT ALL SCENES ---
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
        // === DUMMY R2 UPLOAD (local save, you can wire your R2 here) ===
        const r2Key = `videos/${jobId}.mp4`;
        fs.copyFileSync(stitchedVideoPath, path.join(__dirname, 'tmp', `${jobId}.mp4`));
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
        progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
        cleanupJob(jobId, 60 * 1000);
        finished = true;
        clearTimeout(watchdog);
        console.error(`[15][${jobId}] Final concat/upload error:`, err);
        return;
      }
    } catch (e) {
      progress[jobId] = { percent: 100, status: "Failed: " + e.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      console.error(`[15][${jobId}] Fatal error in video generator:`, e);
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
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithPolly(sampleText, v.id, filePath);
        console.log(`[17] Polly preview generated: ${filePath}`);
      } else {
        console.log(`[17] Polly preview exists: ${filePath}`);
      }
    }
    for (const v of elevenProVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithElevenLabs(sampleText, v.id, filePath);
        console.log(`[17] ElevenLabs preview generated: ${filePath}`);
      } else {
        console.log(`[17] ElevenLabs preview exists: ${filePath}`);
      }
    }
    res.json({ success: true, message: "Voice previews generated." });
  } catch (err) {
    console.error("[17] Voice preview generation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 18. SERVE VIDEOS FROM LOCAL TMP (PROD: SWAP TO R2)
// ==========================================
app.get('/video/videos/:key', async (req, res) => {
  const keyParam = req.params.key;
  const filePath = path.join(__dirname, 'tmp', keyParam);
  console.log(`[18] /video/videos/:key endpoint called. File: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    console.error(`[18] Video not found: ${filePath}`);
    res.status(404).end('Video not found');
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
  fs.createReadStream(filePath)
    .on('error', err => {
      console.error(`[18] Error streaming video:`, err);
      res.status(500).end('Error streaming video');
    })
    .pipe(res);
});

// ==========================================
// 19. PRETTY URLs FOR .HTML PAGES
// ==========================================
app.get('/*.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
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
