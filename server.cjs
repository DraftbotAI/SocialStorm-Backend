/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   -----------------------------------------------------------
   - Load env, modules, API keys, paths
   - Configure AWS + OpenAI + FFmpeg
   =========================================================== */

console.log('\n========== [BOOTING SERVER] ==========');
console.log('[INFO] Booting SocialStormAI backend...');
console.log('[INFO] Loading dependencies...');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const fsExtra = require('fs-extra'); // <-- Added for recursive folder cleanup
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[INFO] FFmpeg path set to:', ffmpegPath);

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWS = require('aws-sdk');
const { OpenAI } = require('openai');

// === JOBS DIR DEFINITION (for temp/progress management) ===
const JOBS_DIR = path.join(__dirname, 'jobs');

console.log('[INFO] Dependencies loaded.');

// === ENV CHECK ===
const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'R2_LIBRARY_BUCKET',
  'R2_ENDPOINT',
  'OPENAI_API_KEY'
];
const missingEnv = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('[FATAL] Missing environment variables:', missingEnv);
  process.exit(1);
}
console.log('[INFO] All required environment variables are present.');

// ==== AWS CONFIG ====
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});
console.log('[INFO] AWS SDK configured.');

// ==== EXPRESS INIT ====
const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

// ==== JOB PROGRESS MAP ====
const progress = {};
console.log('[INFO] Progress tracker initialized.');

// ==== LOAD HELPERS ====
// FIXED: Corrected to use pexels-helper.cjs, not helpers.cjs!
// NOTE: cleanupJob is now defined below, not imported!
const {
  splitScriptToScenes,
  generateSceneAudio,
  findMatchingClip,
  combineAudioAndClip,
  assembleFinalVideo
} = require('./pexels-helper.cjs');

console.log('[INFO] Helper functions loaded.');

// ==== SAFE CLEANUP FUNCTION ====
// Now deletes temp job folder in /renders after each job.
function cleanupJob(jobId) {
  try {
    if (progress[jobId]) {
      delete progress[jobId];
    }
    // Clean up job temp folder in /renders
    const jobDir = path.join(__dirname, 'renders', jobId);
    if (fs.existsSync(jobDir)) {
      fsExtra.removeSync(jobDir); // Recursively deletes all files/folders for this job
      console.log(`[CLEANUP] Removed temp folder: ${jobDir}`);
    }
  } catch (err) {
    console.warn(`[WARN] Cleanup failed for job ${jobId}:`, err);
  }
}



/* ============================================================
   SECTION 2: BASIC ROUTES & STATIC FILE SERVING
   -----------------------------------------------------------
   - Serve frontend files (HTML, assets)
   - Health check + root status
   =========================================================== */

console.log('[INFO] Setting up static file routes...');

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
console.log('[INFO] Static file directory mounted:', PUBLIC_DIR);

// === ROOT SERVES FRONTEND ===
app.get('/', (req, res) => {
  console.log('[REQ] GET /');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// === HEALTH CHECK ===
app.get('/api/status', (req, res) => {
  console.log('[REQ] GET /api/status');
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// === PROGRESS CHECK ===
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  console.log(`[REQ] GET /api/progress/${jobId}`);
  if (progress[jobId]) {
    console.log(`[INFO] Returning progress for job ${jobId}:`, progress[jobId]);
    res.json(progress[jobId]);
  } else {
    console.warn(`[WARN] No progress found for job ${jobId}`);
    res.json({ percent: 100, status: 'Done (or not found)' });
  }
});




/* ===========================================================
   SECTION 3: VOICES ENDPOINTS
   -----------------------------------------------------------
   - Returns all available voices with metadata
   - No placeholders, all live voices with descriptions/tier/preview
   - Logs total voices, breakdown by tier, and request info
   =========================================================== */

console.log('[INFO] Registering /api/voices endpoint...');

const voices = [
  // ===== ELEVENLABS PRO VOICES =====
  { id: "ZthjuvLPty3kTMaNKVKb", name: "Mike (Pro)", description: "ElevenLabs, Deep US Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "6F5Zhi321D3Oq7v1oNT4", name: "Jackson (Pro)", description: "ElevenLabs, Movie Style Narration", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "p2ueywPKFXYa6hdYfSIJ", name: "Tyler (Pro)", description: "ElevenLabs, US Male Friendly", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Olivia (Pro)", description: "ElevenLabs, Warm US Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "FUfBrNit0NNZAwb58KWH", name: "Emily (Pro)", description: "ElevenLabs, Conversational US Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "xctasy8XvGp2cVO9HL9k", name: "Sophia (Pro Kid)", description: "ElevenLabs, US Female Young", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "goT3UYdM9bhm0n2lmKQx", name: "James (Pro UK)", description: "ElevenLabs, British Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "19STyYD15bswVz51nqLf", name: "Amelia (Pro UK)", description: "ElevenLabs, British Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "2h7ex7B1yGrkcLFI8zUO", name: "Pierre (Pro FR)", description: "ElevenLabs, French Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "xNtG3W2oqJs0cJZuTyBc", name: "Claire (Pro FR)", description: "ElevenLabs, French Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "IP2syKL31S2JthzSSfZH", name: "Diego (Pro ES)", description: "ElevenLabs, Spanish Accent Male", provider: "elevenlabs", tier: "Pro", gender: "male", disabled: false },
  { id: "WLjZnm4PkNmYtNCyiCq8", name: "Lucia (Pro ES)", description: "ElevenLabs, Spanish Accent Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: false },
  { id: "zA6D7RyKdc2EClouEMkP", name: "Aimee (ASMR Pro)", description: "Female British Meditation ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false },
  { id: "RCQHZdatZm4oG3N6Nwme", name: "Dr. Lovelace (ASMR Pro)", description: "Pro Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false },
  { id: "RBknfnzK8KHNwv44gIrh", name: "James Whitmore (ASMR Pro)", description: "Gentle Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "male", disabled: false },
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false },

  // ===== POLLY FREE TIER VOICES =====
  { id: "Matthew", name: "Matthew (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Joey", name: "Joey (US Male)", description: "Amazon Polly, Male, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Brian", name: "Brian (British Male)", description: "Amazon Polly, Male, British English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Russell", name: "Russell (Australian Male)", description: "Amazon Polly, Male, Australian English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "male", disabled: false },
  { id: "Joanna", name: "Joanna (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Kimberly", name: "Kimberly (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Amy", name: "Amy (British Female)", description: "Amazon Polly, Female, British English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false },
  { id: "Salli", name: "Salli (US Female)", description: "Amazon Polly, Female, US English (Neural) - Free with AWS Free Tier", provider: "polly", tier: "Free", gender: "female", disabled: false }
];

// ==== Polly Voice List for Validation ====
const POLLY_VOICE_IDS = voices.filter(v => v.provider === "polly").map(v => v.id);

app.get('/api/voices', (req, res) => {
  const now = new Date().toISOString();
  console.log(`[REQ] GET /api/voices @ ${now}`);
  const count = voices.length;
  const byTier = {
    Free: voices.filter(v => v.tier === 'Free').length,
    Pro: voices.filter(v => v.tier === 'Pro').length,
    ASMR: voices.filter(v => v.tier === 'ASMR').length
  };
  console.log(`[INFO] Returning ${count} voices → Free: ${byTier.Free}, Pro: ${byTier.Pro}, ASMR: ${byTier.ASMR}`);
  res.json({ success: true, voices });
});

// ==== EXPORT POLLY VOICE IDS FOR VALIDATION ELSEWHERE ====
module.exports = {
  voices,
  POLLY_VOICE_IDS
};





/* ===========================================================
   SECTION 4: /api/generate-script ENDPOINT
   -----------------------------------------------------------
   - Accepts a video idea
   - Calls OpenAI to generate a punchy, scene-ready script
   - Returns metadata: title, description, hashtags
   - Logs every input, output, error, and GPT call
   =========================================================== */

console.log('[INFO] Registering /api/generate-script endpoint...');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/generate-script', async (req, res) => {
  const idea = req.body.idea?.trim();
  const timestamp = new Date().toISOString();
  console.log(`[REQ] POST /api/generate-script @ ${timestamp}`);
  console.log(`[INPUT] idea = "${idea}"`);

  if (!idea) {
    console.warn('[WARN] Missing idea in request body');
    return res.status(400).json({ success: false, error: "Missing idea" });
  }

  try {
    console.log('[GPT] Calling OpenAI for full script...');
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      temperature: 0.8,
      max_tokens: 800,
      messages: [
        {
          role: "system",
          content: `You're a viral short-form script writer for YouTube Shorts and TikToks.
You always start with a strong hook sentence that grabs attention.
You write punchy, one-line scenes with humor, drama, or mystery.
No animal metaphors. Avoid robotic or academic tone.
Write 6–10 short sentences max, one per line. No intro or summary.
Then add metadata: viral title, SEO description, and hashtags.`
        },
        {
          role: "user",
          content: `Write a viral short-form script about: ${idea}`
        }
      ]
    });

    const raw = completion.choices?.[0]?.message?.content?.trim() || '';
    console.log('[GPT] Response received. Raw length:', raw.length);
    console.log('[RAW OUTPUT START]\n' + raw + '\n[RAW OUTPUT END]');

    let script = '';
    let title = '';
    let description = '';
    let tags = '';

    // Parse output: first lines = script, last = metadata
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const metaStart = lines.findIndex(l => /^title\s*[:\-]/i.test(l));

    if (metaStart === -1) {
      console.warn('[WARN] Could not find metadata section. Returning fallback.');
      script = lines.join('\n');
    } else {
      script = lines.slice(0, metaStart).join('\n');
      const metaLines = lines.slice(metaStart);
      for (const line of metaLines) {
        if (/^title\s*[:\-]/i.test(line))       title = line.split(/[:\-]/)[1]?.trim() || '';
        else if (/^description\s*[:\-]/i.test(line)) description = line.split(/[:\-]/)[1]?.trim() || '';
        else if (/^(tags|hashtags)\s*[:\-]/i.test(line)) tags = line.split(/[:\-]/)[1]?.trim() || '';
      }
    }

    if (!script) {
      console.error('[ERROR] No script extracted from GPT response.');
      return res.status(500).json({ success: false, error: "Script parsing failed" });
    }

    // Default fallbacks
    if (!title) title = idea.length < 60 ? idea : idea.slice(0, 57) + "...";
    if (!description) description = `Here's a quick look at "${idea}" – stay tuned.`;
    if (!tags) tags = "#shorts #viral";

    console.log('[PARSED] script lines:', script.split('\n').length);
    console.log('[PARSED] title:', title);
    console.log('[PARSED] description:', description);
    console.log('[PARSED] tags:', tags);

    res.json({
      success: true,
      script,
      title,
      description,
      hashtags: tags
    });

  } catch (err) {
    console.error('[FATAL] Script generation failed:', err);
    res.status(500).json({ success: false, error: "Script generation failed" });
  }
});



/* ===========================================================
   SECTION 5: VIDEO GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-video
   - Handles script, voice, branding, watermark, outro, background music
   - Bulletproof file/dir safety; logs every step
   =========================================================== */

console.log('[INIT] Video generation endpoint initialized');

// === Import Polly voices list and all voices for provider branching ===


app.post('/api/generate-video', (req, res) => {
  console.log('[REQ] POST /api/generate-video');
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  console.log(`[INFO] New job started: ${jobId}`);
  res.json({ jobId });

  (async () => {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
        console.warn(`[WATCHDOG] Job ${jobId} timed out and was cleaned up`);
      }
    }, 12 * 60 * 1000); // 12 minutes

    try {
      // Parse inputs
      const {
        script = '',
        voice = '',
        paidUser = false,
        removeWatermark = false
      } = req.body || {};
      console.log(`[STEP] Inputs parsed. Voice: ${voice} | Paid: ${paidUser} | Watermark removed: ${removeWatermark}`);

      // Validate
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: Missing script or voice.' };
        cleanupJob(jobId);
        clearTimeout(watchdog);
        return;
      }

      // === DETERMINE VOICE PROVIDER ===
      const selectedVoice = voices.find(v => v.id === voice);
      let ttsProvider = selectedVoice ? selectedVoice.provider : null;

      if (!ttsProvider) {
        progress[jobId] = { percent: 100, status: `Failed: Unknown voice selected (${voice}).` };
        cleanupJob(jobId);
        clearTimeout(watchdog);
        return;
      }

      // === PROVIDER-SPECIFIC VALIDATION ===
      if (ttsProvider === 'polly') {
        if (!POLLY_VOICE_IDS.includes(voice)) {
          progress[jobId] = { percent: 100, status: `Failed: Invalid AWS Polly voice selected (${voice}).` };
          cleanupJob(jobId);
          clearTimeout(watchdog);
          return;
        }
      }
      if (ttsProvider === 'elevenlabs') {
        // No ID validation needed here (IDs are unique per account/project).
        // If you later want to restrict to enabled voices, do it here.
      }

      // Prepare work dir
      const workDir = path.join(__dirname, 'renders', jobId);
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
      console.log(`[STEP] Work dir created: ${workDir}`);

      // Split script to scenes
      const scenes = splitScriptToScenes(script);
      if (!scenes.length) {
        progress[jobId] = { percent: 100, status: 'Failed: Script split error.' };
        cleanupJob(jobId);
        clearTimeout(watchdog);
        return;
      }
      console.log(`[STEP] Script split to ${scenes.length} scenes.`);

      // Main scene processing loop
      let scenePaths = [];
      for (let i = 0; i < scenes.length; i++) {
        const sceneText = scenes[i];
        const sceneBase = `scene${i + 1}`;
        const audioPath = path.join(workDir, `${sceneBase}-audio.mp3`);
        const videoPath = path.join(workDir, `${sceneBase}-video.mp4`);
        const outputScenePath = path.join(workDir, `${sceneBase}-final.mp4`);

        progress[jobId] = { percent: Math.round((i / scenes.length) * 70), status: `Processing scene ${i + 1}...` };
        console.log(`[SCENE] Processing scene ${i + 1}/${scenes.length}: "${sceneText}"`);

        // === Generate audio for scene ===
        try {
          let ttsConfig;
          if (ttsProvider === 'polly') {
            ttsConfig = {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              region: process.env.AWS_REGION
            };
          } else if (ttsProvider === 'elevenlabs') {
            ttsConfig = {
              apiKey: process.env.ELEVENLABS_API_KEY // Make sure this is in your .env!
            };
          } else {
            throw new Error(`Unknown TTS provider: ${ttsProvider}`);
          }

          await generateSceneAudio(sceneText, voice, audioPath, ttsProvider, ttsConfig);
          console.log(`[AUDIO] Audio generated at: ${audioPath}`);
        } catch (err) {
          console.error(`[ERR] Audio generation failed for scene ${i + 1}:`, err);
          progress[jobId] = { percent: 100, status: `Failed: Audio generation error for scene ${i + 1}` };
          cleanupJob(jobId);
          clearTimeout(watchdog);
          return;
        }

        // === Find video clip for scene ===
        let visualSubject = '';
        try {
          visualSubject = await getVisualSubject(sceneText, process.env.OPENAI_API_KEY);
          if (!visualSubject) visualSubject = sceneText;
        } catch (err) {
          visualSubject = sceneText;
        }
        let clipResult = null;
        try {
          clipResult = await findBestClip(
            visualSubject,
            process.env.OPENAI_API_KEY,
            r2Client,
            process.env.R2_LIBRARY_BUCKET,
            process.env.PEXELS_API_KEY,
            process.env.PIXABAY_API_KEY
          );
        } catch (err) {
          console.error(`[ERR] Video clip match failed for scene ${i + 1}:`, err);
        }
        if (!clipResult || !clipResult.url) {
          progress[jobId] = { percent: 100, status: `Failed: No video found for scene ${i + 1}` };
          cleanupJob(jobId);
          clearTimeout(watchdog);
          return;
        }
        console.log(`[VIDEO] Clip for scene ${i + 1}:`, clipResult);

        // === Download or copy video ===
        try {
          if (clipResult.source === 'r2') {
            // R2: Copy from R2 to local path
            await downloadR2FileToLocal(r2Client, process.env.R2_LIBRARY_BUCKET, clipResult.url, videoPath);
            console.log(`[VIDEO] Downloaded from R2: ${videoPath}`);
          } else {
            // Pexels/Pixabay: Download via HTTP
            await downloadRemoteFileToLocal(clipResult.url, videoPath);
            console.log(`[VIDEO] Downloaded from remote: ${videoPath}`);
          }
        } catch (err) {
          console.error(`[ERR] Video download failed for scene ${i + 1}:`, err);
          progress[jobId] = { percent: 100, status: `Failed: Download error for scene ${i + 1}` };
          cleanupJob(jobId);
          clearTimeout(watchdog);
          return;
        }

        // === Combine audio & video for scene ===
        try {
          await combineAudioAndVideo(audioPath, videoPath, outputScenePath);
          scenePaths.push(outputScenePath);
          console.log(`[STEP] Scene ${i + 1} combined: ${outputScenePath}`);
        } catch (err) {
          console.error(`[ERR] Combine audio/video failed for scene ${i + 1}:`, err);
          progress[jobId] = { percent: 100, status: `Failed: Scene combine error for scene ${i + 1}` };
          cleanupJob(jobId);
          clearTimeout(watchdog);
          return;
        }
      }

      // === Stitch all scenes together ===
      progress[jobId] = { percent: 80, status: 'Stitching all scenes...' };
      const stitchedPath = path.join(workDir, `stitched.mp4`);
      try {
        await stitchScenes(scenePaths, stitchedPath);
        console.log(`[STEP] Scenes stitched to: ${stitchedPath}`);
      } catch (err) {
        console.error(`[ERR] Stitched scenes failed:`, err);
        progress[jobId] = { percent: 100, status: 'Failed: Scene stitching error' };
        cleanupJob(jobId);
        clearTimeout(watchdog);
        return;
      }

      // === Add watermark/outro/background music as needed ===
      let finalOutputPath = path.join(workDir, `final.mp4`);
      try {
        await addFinalTouches(
          stitchedPath,
          finalOutputPath,
          { watermark: !removeWatermark, outro: !removeWatermark, backgroundMusic: true }
        );
        console.log(`[STEP] Final touches applied: ${finalOutputPath}`);
      } catch (err) {
        console.error(`[ERR] Final touches failed:`, err);
        progress[jobId] = { percent: 100, status: 'Failed: Final touches error' };
        cleanupJob(jobId);
        clearTimeout(watchdog);
        return;
      }

      // === Job done ===
      progress[jobId] = { percent: 100, status: 'Done', key: path.relative(path.join(__dirname, 'renders'), finalOutputPath) };
      finished = true;
      clearTimeout(watchdog);
      cleanupJob(jobId);
      console.log(`[DONE] Video generation complete for job ${jobId}`);
    } catch (err) {
      console.error(`[ERR] Video generation flow crashed:`, err);
      progress[jobId] = { percent: 100, status: 'Failed: Server error' };
      cleanupJob(jobId);
      clearTimeout(watchdog);
    }
  })();
});







/* ===========================================================
   SECTION 6: THUMBNAIL GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-thumbnails
   - Uses Canvas to generate 10 viral thumbnails
   - Handles custom caption, topic, ZIP packing, watermarking
   - Bulletproof error handling, no skips
   =========================================================== */

const { createCanvas, loadImage, registerFont } = require('canvas');

// Optionally register extra fonts for viral style
const fontPath = path.join(__dirname, 'frontend', 'assets', 'fonts', 'LuckiestGuy-Regular.ttf');
if (fs.existsSync(fontPath)) {
  registerFont(fontPath, { family: 'LuckiestGuy' });
  console.log('[FONT] Registered LuckiestGuy font:', fontPath);
} else {
  console.warn('[FONT] LuckiestGuy font missing:', fontPath);
}

app.post('/api/generate-thumbnails', async (req, res) => {
  console.log('[REQ] POST /api/generate-thumbnails');
  try {
    const { topic = '', caption = '' } = req.body;
    console.log('[INPUT] topic:', topic, 'caption:', caption);
    let label = (caption && caption.length > 2) ? caption : topic;
    if (!label || label.length < 2) {
      console.warn('[WARN] Missing topic or caption. User must enter at least 2 chars.');
      return res.json({ success: false, error: "Enter a topic or caption." });
    }

    const baseThumbsDir = path.join(__dirname, 'frontend', 'assets', 'thumbnail_templates');
    console.log('[DIR] Loading template dir:', baseThumbsDir);

    // Simple: pick 10 random template backgrounds (PNG/SVG)
    const allTemplates = fs.readdirSync(baseThumbsDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => path.join(baseThumbsDir, f));
    console.log('[DIR] Found', allTemplates.length, 'thumbnail template files.');
    // Bulletproof: skip dirs, only files
    const templateFiles = allTemplates.filter(f => fs.statSync(f).isFile());
    console.log('[DIR] Usable template files:', templateFiles.length);

    // If <10 available, repeat
    let picks = [];
    for (let i = 0; i < 10; i++) {
      picks.push(templateFiles[i % templateFiles.length]);
    }
    console.log('[PICK] Template picks for batch:', picks);

    let previews = [];
    for (let i = 0; i < 10; i++) {
      const canvas = createCanvas(480, 270); // 16:9
      const ctx = canvas.getContext('2d');
      // Background
      if (fs.existsSync(picks[i])) {
        const bgImg = await loadImage(picks[i]);
        ctx.drawImage(bgImg, 0, 0, 480, 270);
      } else {
        ctx.fillStyle = '#10141a';
        ctx.fillRect(0, 0, 480, 270);
      }
      // Text
      ctx.font = `bold 48px 'LuckiestGuy', Arial, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#00e0fe';
      ctx.shadowBlur = 12;
      ctx.fillText(label, 240, 148, 420);

      // Watermark (for preview)
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.32;
      ctx.font = 'bold 34px Arial, sans-serif';
      ctx.fillStyle = '#00e0fe';
      ctx.fillText('SOCIALSTORM.AI', 240, 265, 470);
      ctx.globalAlpha = 1.0;

      const dataUrl = canvas.toDataURL('image/png');
      previews.push({ idx: i + 1, dataUrl });
      console.log(`[PREVIEW] Generated preview ${i+1}/10`);
    }

    // Make ZIP (for unlock/download)
    console.log('[ZIP] Creating ZIP of thumbnails...');
    const zip = new JSZip();
    for (let i = 0; i < previews.length; i++) {
      // Remove watermark for zip
      const canvas = createCanvas(480, 270);
      const ctx = canvas.getContext('2d');
      if (fs.existsSync(picks[i])) {
        const bgImg = await loadImage(picks[i]);
        ctx.drawImage(bgImg, 0, 0, 480, 270);
      } else {
        ctx.fillStyle = '#10141a';
        ctx.fillRect(0, 0, 480, 270);
      }
      ctx.font = `bold 48px 'LuckiestGuy', Arial, sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.shadowColor = '#00e0fe';
      ctx.shadowBlur = 12;
      ctx.fillText(label, 240, 148, 420);

      zip.file(`SocialStorm-thumbnail-${i+1}.png`, canvas.toBuffer('image/png'));
      console.log(`[ZIP] Added thumbnail ${i+1}/10 to ZIP`);
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    // Store ZIP to temp dir for download
    const zipName = `thumbs_${uuidv4()}.zip`;
    const zipPath = path.join(JOBS_DIR, zipName);
    fs.writeFileSync(zipPath, zipBuf);
    console.log('[ZIP] Wrote ZIP to', zipPath);

    // Provide previews as dataUrl, and link to download ZIP for "unlock"
    res.json({
      success: true,
      previews,
      zip: `/download/thumbs/${zipName}`
    });
    console.log('[DONE] Thumbnail generation and ZIP done.');
  } catch (err) {
    console.error('[ERROR] /api/generate-thumbnails:', err);
    res.json({ success: false, error: "Failed to generate thumbnails." });
  }
});


/* ===========================================================
   SECTION 7: DOWNLOAD & VIDEO SERVE ENDPOINTS
   -----------------------------------------------------------
   - Download ZIPs, serve videos directly from S3/R2 or temp
   - Bulletproof path checking, never serves a directory
   - GOD-TIER LOGGING: logs all requests, file operations, S3 keys, and errors
   =========================================================== */

// ---- Download ZIP for thumbnails ----
app.get('/download/thumbs/:zipName', (req, res) => {
  const file = path.join(JOBS_DIR, req.params.zipName);
  console.log('[REQ] GET /download/thumbs/' + req.params.zipName);
  console.log('[FILE] Attempting download:', file);

  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    console.log('[FILE] ZIP exists, serving download...');
    res.download(file, err => {
      if (!err) {
        console.log('[FILE] Downloaded successfully, will delete in 2.5s:', file);
        setTimeout(() => {
          try {
            fs.unlinkSync(file);
            console.log('[FILE] Deleted ZIP after download:', file);
          } catch (e) {
            console.error('[FILE] Failed to delete ZIP after download:', file, e);
          }
        }, 2500);
      } else {
        console.error('[FILE] Error sending download:', file, err);
      }
    });
  } else {
    console.warn('[WARN] ZIP file not found or not a file:', file);
    res.status(404).send('File not found');
  }
});

// ---- Serve generated video from S3/R2 ----
app.get('/video/:key', async (req, res) => {
  const key = req.params.key;
  console.log('[REQ] GET /video/' + key);
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    });
    console.log('[S3] Fetching video from bucket:', process.env.AWS_BUCKET_NAME, 'Key:', key);
    const response = await s3Client.send(command);

    res.setHeader('Content-Type', 'video/mp4');
    if (response.ContentLength)
      res.setHeader('Content-Length', response.ContentLength);

    console.log('[S3] Streaming video to client:', key);
    response.Body.pipe(res);
  } catch (err) {
    console.error('[ERROR] /video/:key', key, err);
    res.status(404).send('Video not found');
  }
});


/* ===========================================================
   SECTION 8: CONTACT FORM ENDPOINT
   -----------------------------------------------------------
   - POST /api/contact
   - Accepts form message, sends to admin email or logs
   - GOD-TIER LOGGING: logs all inputs, results, errors
   =========================================================== */

app.post('/api/contact', async (req, res) => {
  console.log('[REQ] POST /api/contact');
  try {
    const { name = '', email = '', message = '' } = req.body;
    console.log('[CONTACT INPUT] Name:', name, 'Email:', email, 'Message:', message);
    if (!name || !email || !message) {
      console.warn('[WARN] Missing contact form fields.');
      return res.json({ success: false, error: "Please fill out all fields." });
    }
    // Normally: send email via SendGrid/Mailgun/etc. Here, just log.
    console.log(`[CONTACT] Message received from: ${name} <${email}>  Message: ${message}`);
    res.json({ success: true, status: "Message received!" });
  } catch (err) {
    console.error('[ERROR] /api/contact:', err);
    res.json({ success: false, error: "Failed to send message." });
  }
});


/* ===========================================================
   SECTION 9: ERROR HANDLING & SERVER START
   -----------------------------------------------------------
   - 404 catchall
   - Start server on chosen port
   - GOD-TIER LOGGING: logs server startup and bad routes
   =========================================================== */

app.use((req, res) => {
  console.warn('[404] Route not found:', req.originalUrl);
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🟢 SocialStormAI backend running on port ${PORT}`);
});
