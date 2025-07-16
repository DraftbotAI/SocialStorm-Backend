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
// 7. HELPERS (ALL FALLBACKS & UTILITIES HERE)
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

// === CLIP LIBRARY/PEXELS/PIXABAY fallback ===
// [If you have real logic for local clips or R2, wire it here. This will never fail or block.]
// TODO: Replace these with your actual local library/pexels/pixabay search if available.
async function getR2ClipList() { return []; }
async function downloadFromR2ToFile() { return null; }
async function findBestClipForScene(sceneText, workDir, usedClips = []) {
  // Plug in your local vault/R2 search here.
  // For now: just return null and let the main code fall back to black clip.
  console.warn(`[7] findBestClipForScene: No real search implemented. Returning null for "${sceneText}"`);
  return null;
}

// ========== VOICES (FULL LIST) ==========
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
// 8. VIRAL METADATA ENGINE (PRODUCTION)
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
// 9. SCRIPT-TO-SCENES SPLITTER (PRODUCTION)
// ==========================================
function splitScriptToScenes(script) {
  return (script || "")
    .split(/(?<=[.!?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
}

// ==========================================
// 10. ELEVENLABS & POLLY TTS SYNTHESIZER (PRODUCTION)
// ==========================================
async function synthesizeWithElevenLabs(text, voice, outFile) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("No ElevenLabs API Key");
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      { text, model_id: "eleven_monolingual_v1" },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, responseType: "arraybuffer" }
    );
    fs.writeFileSync(outFile, ttsRes.data);
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
  return new Promise((resolve, reject) => {
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        console.error("[10] Polly error:", err.message);
        return reject(new Error("Polly error: " + err.message));
      }
      if (data && data.AudioStream instanceof Buffer) {
        fs.writeFileSync(outFile, data.AudioStream);
        resolve(outFile);
      } else {
        reject(new Error("Polly synthesis failed, no audio stream."));
      }
    });
  });
}

// ==========================================
// 11. /api/voices ENDPOINT (PRODUCTION)
// ==========================================
app.get('/api/voices', (req, res) => {
  const mappedCustomVoices = [...pollyVoices, ...elevenProVoices];
  res.json({ success: true, voices: mappedCustomVoices });
});

// ==========================================
// 12. /api/generate-script ENDPOINT (PRODUCTION)
// ==========================================
app.post('/api/generate-script', async (req, res) => {
  const ideaRaw = req.body.idea;
  if (typeof ideaRaw !== "string" || !ideaRaw.trim()) {
    return res.status(400).json({ success: false, error: "Invalid or missing 'idea' parameter." });
  }
  const idea = ideaRaw.trim();
  try {
    if (!openai || !process.env.OPENAI_API_KEY) {
      return res.status(503).json({ success: false, error: "OpenAI unavailable." });
    }
    const hookPrompt = `Write a viral short-form video script for the topic: "${idea}". Each sentence on its own line. Hook in first line. Max 60s total. Format:\n\nLine 1\nLine 2\n...`;
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
    let lines = script.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length > 20) lines = lines.slice(0, 20);
    script = lines.join('\n');
    const viralMeta = await generateViralMetadata(script);
    return res.json({
      success: true,
      script,
      title: viralMeta.title,
      description: viralMeta.description,
      tags: viralMeta.tags
    });
  } catch (error) {
    console.error("[/api/generate-script] Error:", error);
    return res.status(500).json({ success: false, error: "Failed to generate script. Try again." });
  }
});

// ==========================================
// 13. SPARKIE (IDEA GENERATOR) ENDPOINT (PRODUCTION)
// ==========================================
app.post('/api/sparkie', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt required' });
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
    return res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// ==========================================
// 14. /api/generate-thumbnails ENDPOINT (PRODUCTION)
// ==========================================
app.post('/api/generate-thumbnails', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ success: false, error: 'Topic required' });

  // You can expand this to use real backgrounds, fonts, etc.
  const fontFiles = [
    'Impact.ttf','Anton-Regular.ttf','BebasNeue-Regular.ttf','LeagueGothic-Regular.ttf','Oswald-Regular.ttf','Montserrat-Bold.ttf','Poppins-Bold.ttf','Raleway-Black.ttf','Roboto-Bold.ttf','ArchivoBlack-Regular.ttf'
  ];
  fontFiles.forEach((font, i) => {
    try { registerFont(path.join(__dirname, 'fonts', font), { family: `ViralFont${i}` }); }
    catch (err) { }
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
  }
  return res.json({ success: true, thumbnails });
});
// ==========================================
// 15. /api/generate-video ENDPOINT (PRODUCTION)
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
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  res.json({ jobId });

  (async () => {
    let finished = false;
    let watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
      }
    }, 10 * 60 * 1000);

    try {
      const { script, voice } = req.body;
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }

      // Metadata: always generated, never blocks video creation
      let viralTitle = '', viralDesc = '', viralTags = '';
      try {
        const meta = await generateViralMetadata(script);
        viralTitle = meta.title;
        viralDesc = meta.description;
        viralTags = meta.tags;
      } catch (metaErr) {
        console.warn(`[15][${jobId}] Metadata error: ${metaErr.message}`);
      }
      progress[jobId].viralTitle = viralTitle;
      progress[jobId].viralDesc  = viralDesc;
      progress[jobId].viralTags  = viralTags;

      const steps = splitScriptToScenes(script).slice(0, 20);
      const totalSteps = steps.length + 5;
      let currentStep = 0;

      if (!steps.length) throw new Error('No scenes found in script.');

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

          // --- 1. TTS (Polly/ElevenLabs) ---
          const audioPath = path.join(workDir, `scene-${i + 1}.mp3`);
          if (pollyVoices.map(v => v.id).includes(voice)) {
            await synthesizeWithPolly(sceneText, voice, audioPath);
          } else {
            await synthesizeWithElevenLabs(sceneText, voice, audioPath);
          }

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
          }
          usedClipPaths.push(clipPath);

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
        } catch (err) {
          progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
          cleanupJob(jobId, 10 * 1000);
          finished = true;
          clearTimeout(watchdog);
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
      } catch (err) {
        progress[jobId] = { percent: 100, status: "Failed: " + err.message, viralTitle, viralDesc, viralTags };
        cleanupJob(jobId, 60 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }
    } catch (e) {
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
  if (!job) return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  res.json(job);
});

// ==========================================
// 17. GENERATE VOICE PREVIEWS ENDPOINT
// ==========================================
app.post('/api/generate-voice-previews', async (req, res) => {
  const sampleText = "This is a sample of my voice.";
  try {
    for (const v of pollyVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithPolly(sampleText, v.id, filePath);
      }
    }
    for (const v of elevenProVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithElevenLabs(sampleText, v.id, filePath);
      }
    }
    res.json({ success: true, message: "Voice previews generated." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 18. SERVE VIDEOS FROM LOCAL TMP (PROD: SWAP TO R2)
// ==========================================
app.get('/video/videos/:key', async (req, res) => {
  const keyParam = req.params.key;
  const filePath = path.join(__dirname, 'tmp', keyParam);
  if (!fs.existsSync(filePath)) {
    res.status(404).end('Video not found');
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
  fs.createReadStream(filePath).pipe(res);
});

// ==========================================
// 19. PRETTY URLs FOR .HTML PAGES
// ==========================================
app.get('/*.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
  if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
    res.sendFile(htmlPath);
  } else {
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
    } else {
      const fallback = path.join(__dirname, 'frontend', 'index.html');
      res.sendFile(fallback);
    }
  } else {
    res.status(404).json({ error: 'Not found.' });
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
