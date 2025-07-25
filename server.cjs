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
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[INFO] FFmpeg path set to:', ffmpegPath);

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWS = require('aws-sdk');
const { OpenAI } = require('openai');

console.log('[INFO] Dependencies loaded.');

// === ENV CHECK ===
const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'R2_LIBRARY_BUCKET',
  'R2_ENDPOINT',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'CLOUDINARY_CLOUD_NAME',
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
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

// ==== JOB PROGRESS MAP ====
const progress = {};
console.log('[INFO] Progress tracker initialized.');

// ==== LOAD HELPERS ====
const {
  splitScriptToScenes,
  generateSceneAudio,
  findMatchingClip,
  combineAudioAndClip,
  assembleFinalVideo,
  cleanupJob
} = require('./helpers.cjs');

console.log('[INFO] Helper functions loaded.');



/* ===========================================================
   SECTION 2: BASIC ROUTES & STATIC FILE SERVING
   -----------------------------------------------------------
   - Serve frontend files (HTML, assets)
   - Health check + root status
   =========================================================== */

console.log('[INFO] Setting up static file routes...');

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
console.log('[INFO] Static file directory mounted:', PUBLIC_DIR);

// === ROOT TEST ===
app.get('/', (req, res) => {
  console.log('[REQ] GET /');
  res.send('🌀 SocialStormAI backend is running.');
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
  // ===== FREE (AWS POLLY) VOICES =====
  {
    id: "polly-matthew",
    name: "Matthew",
    description: "Warm, natural American male (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-matthew.mp3",
    disabled: false
  },
  {
    id: "polly-joanna",
    name: "Joanna",
    description: "Friendly, crisp American female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-joanna.mp3",
    disabled: false
  },
  {
    id: "polly-joey",
    name: "Joey",
    description: "Conversational American male (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-joey.mp3",
    disabled: false
  },
  {
    id: "polly-kimberly",
    name: "Kimberly",
    description: "Young, relatable American female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-kimberly.mp3",
    disabled: false
  },
  {
    id: "polly-amy",
    name: "Amy",
    description: "Clear and professional British female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-amy.mp3",
    disabled: false
  },
  {
    id: "polly-brian",
    name: "Brian",
    description: "British male, upbeat and sharp (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-brian.mp3",
    disabled: false
  },
  {
    id: "polly-russell",
    name: "Russell",
    description: "Australian male, fun and clear (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-russell.mp3",
    disabled: false
  },
  {
    id: "polly-salli",
    name: "Salli",
    description: "Neutral, friendly American female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-salli.mp3",
    disabled: false
  },

  // ===== PRO (ELEVENLABS) VOICES =====
  {
    id: "11labs-mike",
    name: "Mike",
    description: "Polished, professional American male (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-mike.mp3",
    disabled: true
  },
  {
    id: "11labs-jackson",
    name: "Jackson",
    description: "Casual, confident American male (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-jackson.mp3",
    disabled: true
  },
  {
    id: "11labs-tyler",
    name: "Tyler",
    description: "Bold, high-energy male voice (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-tyler.mp3",
    disabled: true
  },
  {
    id: "11labs-olivia",
    name: "Olivia",
    description: "Casual, upbeat American female (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-olivia.mp3",
    disabled: true
  },
  {
    id: "11labs-emily",
    name: "Emily",
    description: "Warm, storytelling American female (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-emily.mp3",
    disabled: true
  },
  {
    id: "11labs-sophia",
    name: "Sophia",
    description: "Smooth, classy female voice (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-sophia.mp3",
    disabled: true
  },
  {
    id: "11labs-james",
    name: "James",
    description: "Deep, powerful male narrator (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-james.mp3",
    disabled: true
  },
  {
    id: "11labs-amelia",
    name: "Amelia",
    description: "Soft, comforting female tone (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-amelia.mp3",
    disabled: true
  },
  {
    id: "11labs-pierre",
    name: "Pierre",
    description: "French-accented male, smooth and formal (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-pierre.mp3",
    disabled: true
  },
  {
    id: "11labs-claire",
    name: "Claire",
    description: "French-accented female, elegant and soft (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-claire.mp3",
    disabled: true
  },
  {
    id: "11labs-diego",
    name: "Diego",
    description: "Spanish-accented male, dynamic and bold (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-diego.mp3",
    disabled: true
  },
  {
    id: "11labs-lucia",
    name: "Lucia",
    description: "Spanish-accented female, passionate and clear (Pro)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-lucia.mp3",
    disabled: true
  },

  // ===== ASMR PRO (WHISPER-TIER) =====
  {
    id: "11labs-aimee-asmr",
    name: "Aimee (ASMR Pro)",
    description: "Whisper-soft ASMR female (Pro, ASMR)",
    tier: "ASMR",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-aimee-asmr.mp3",
    disabled: true
  },
  {
    id: "11labs-james-whitmore",
    name: "James Whitmore (ASMR Pro)",
    description: "Soothing, wise storyteller male (Pro, ASMR)",
    tier: "ASMR",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-james-whitmore.mp3",
    disabled: true
  },
  {
    id: "11labs-dr-lovelace",
    name: "Dr. Lovelace (ASMR Pro)",
    description: "Intimate, breathy female whisper (Pro, ASMR)",
    tier: "ASMR",
    provider: "ElevenLabs",
    preview: "/assets/voices/11labs-dr-lovelace.mp3",
    disabled: true
  }
];

app.get('/api/voices', (req, res) => {
  console.log(`[REQ] GET /api/voices @ ${new Date().toISOString()}`);
  const count = voices.length;
  const byTier = {
    Free: voices.filter(v => v.tier === 'Free').length,
    Pro: voices.filter(v => v.tier === 'Pro').length,
    ASMR: voices.filter(v => v.tier === 'ASMR').length
  };
  console.log(`[INFO] Returning ${count} voices → Free: ${byTier.Free}, Pro: ${byTier.Pro}, ASMR: ${byTier.ASMR}`);
  res.json({ success: true, voices });
});





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

const progress = {}; // Job status by jobId
console.log('[INIT] Video generation endpoint initialized');

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
        console.warn(`[WATCHDOG] Job ${jobId} timed out and cleaned up.`);
      }
    }, 12 * 60 * 1000); // 12 min max

    let workDir = null;
    let sceneFiles = [];
    let totalSteps = 0;
    let currentStep = 0;
    let paidUser = false;
    let removeWatermark = false;
    let selectedVoice = "polly-matthew";
    let script = '';

    try {
      // --- Validate and extract payload ---
      console.log('[INPUT] Payload:', req.body);
      script = req.body.script || '';
      selectedVoice = req.body.voice || 'polly-matthew';
      paidUser = !!req.body.paidUser;
      removeWatermark = !!req.body.removeWatermark;

      if (!script || typeof script !== "string" || script.length < 10) {
        console.warn('[WARN] Invalid or empty script');
        progress[jobId] = { percent: 100, status: "Failed: No script." };
        return cleanupJob(jobId);
      }
      if (!selectedVoice || typeof selectedVoice !== "string") {
        console.warn('[WARN] Invalid or missing voice');
        progress[jobId] = { percent: 100, status: "Failed: No voice." };
        return cleanupJob(jobId);
      }

      // --- Working directory for this job ---
      workDir = path.join(JOBS_DIR, jobId);
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
        console.log('[FS] Created working dir:', workDir);
      }

      // --- Step 1: Split script into scenes ---
      console.log('[INFO] Splitting script into lines...');
      const lines = script.split('\n').map(line => line.trim()).filter(Boolean);
      console.log('[INFO] Scene count:', lines.length);
      totalSteps = lines.length + 3; // audio, merge, finalize

      // --- Step 2: Generate scene audio (Polly for now, future: ElevenLabs) ---
      let audioFiles = [];
      let sceneIdx = 1;
      for (const line of lines) {
        currentStep++;
        progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: `Generating audio for scene ${sceneIdx}` };
        let voiceId = "Matthew";
        if (selectedVoice.startsWith("polly-")) voiceId = selectedVoice.replace("polly-", "");
        console.log(`[TTS] Synthesizing scene ${sceneIdx} with Polly voice: ${voiceId}`);
        const polly = new AWS.Polly();
        const audioRes = await polly.synthesizeSpeech({
          OutputFormat: 'mp3',
          Text: line,
          VoiceId: voiceId,
          Engine: "neural"
        }).promise();
        const audioPath = path.join(workDir, `scene${sceneIdx}.mp3`);
        fs.writeFileSync(audioPath, audioRes.AudioStream);
        console.log(`[TTS] Saved audio to ${audioPath}`);
        audioFiles.push(audioPath);
        sceneIdx++;
      }

      // --- Step 3: Select video clips for each scene ---
      let videoFiles = [];
      sceneIdx = 1;
      for (const line of lines) {
        currentStep++;
        progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: `Selecting video for scene ${sceneIdx}` };
        console.log(`[CLIP] Selecting clip for scene ${sceneIdx}`);
        let videoPath = path.join(__dirname, 'frontend', 'assets', 'stock_clips', `clip${sceneIdx}.mp4`);
        if (!fs.existsSync(videoPath)) videoPath = path.join(__dirname, 'frontend', 'assets', 'stock_clips', `clip1.mp4`);
        if (fs.existsSync(videoPath) && fs.statSync(videoPath).isFile()) {
          videoFiles.push(videoPath);
        } else {
          console.error('[EISDIR FAILSAFE] Video path not a file:', videoPath);
        }
        sceneIdx++;
      }

      // --- Step 4: Merge audio & video for each scene ---
      sceneFiles = [];
      for (let i = 0; i < lines.length; i++) {
        currentStep++;
        progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: `Merging scene ${i+1}` };
        const vPath = videoFiles[i];
        const aPath = audioFiles[i];
        const outPath = path.join(workDir, `scene${i+1}_out.mp4`);
        if (
          fs.existsSync(vPath) && fs.statSync(vPath).isFile() &&
          fs.existsSync(aPath) && fs.statSync(aPath).isFile()
        ) {
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(vPath)
              .input(aPath)
              .outputOptions([
                '-c:v', 'libx264',
                '-c:a', 'aac',
                '-shortest',
                '-preset', 'veryfast',
                '-movflags', '+faststart'
              ])
              .save(outPath)
              .on('end', resolve)
              .on('error', reject);
          });
          console.log(`[MERGE] Scene ${i+1} complete.`);
          sceneFiles.push(outPath);
        } else {
          console.error('[EISDIR FAILSAFE] Skipped merge: file missing or is directory.', vPath, aPath);
        }
      }

      // --- Step 5: Concat all scenes ---
      currentStep++;
      progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: "Concatenating scenes" };
      const fileListPath = path.join(workDir, 'filelist.txt');
      const concatList = sceneFiles
        .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
        .map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
      console.log('[CONCAT] Writing filelist.txt with', sceneFiles.length, 'scenes');
      fs.writeFileSync(fileListPath, concatList);

      const concatOut = path.join(workDir, 'concat.mp4');
      console.log('[CONCAT] Running ffmpeg concat...');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(fileListPath)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy'])
          .save(concatOut)
          .on('end', resolve)
          .on('error', reject);
      });

      // --- Step 6: Watermark/Outro/Branding (Windows-safe, Arial) ---
      let finalOut = path.join(workDir, 'final.mp4');
      let ffmpegCmd = ffmpeg().input(concatOut);

      // Watermark for free users only
      if (!paidUser || !removeWatermark) {
        const watermark = path.join(__dirname, 'frontend', 'assets', 'watermark.png');
        if (fs.existsSync(watermark)) {
          ffmpegCmd = ffmpegCmd
            .complexFilter([
              {
                filter: 'overlay',
                options: { x: '(main_w-overlay_w)-16', y: '(main_h-overlay_h)-16' }
              }
            ]);
          console.log('[FINAL] Watermark overlay added');
        }
      }

      ffmpegCmd
        .outputOptions([
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-preset', 'veryfast',
          '-movflags', '+faststart'
        ])
        .save(finalOut);

      console.log('[FINAL] Adding watermark and encoding...');
      await new Promise((resolve, reject) => {
        ffmpegCmd.on('end', resolve).on('error', reject);
      });

      // --- Step 7: Append outro for free users (if exists) ---
      if (!paidUser || !removeWatermark) {
        const outro = path.join(__dirname, 'frontend', 'assets', 'outro.mp4');
        if (fs.existsSync(outro) && fs.statSync(outro).isFile()) {
          const outroConcatList = path.join(workDir, 'outrolist.txt');
          fs.writeFileSync(outroConcatList,
            `file '${finalOut.replace(/\\/g, '/')}'\nfile '${outro.replace(/\\/g, '/')}'\n`);
          const outroOut = path.join(workDir, 'final_with_outro.mp4');
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(outroConcatList)
              .inputOptions(['-f', 'concat', '-safe', '0'])
              .outputOptions(['-c', 'copy'])
              .save(outroOut)
              .on('end', resolve)
              .on('error', reject);
          });
          finalOut = outroOut;
          console.log('[FINAL] Outro appended for free user');
        }
      }

      // --- Step 8: Upload to S3/R2, set up public URL ---
      const videoKey = `${jobId}.mp4`;
      const videoData = fs.readFileSync(finalOut);
      console.log(`[UPLOAD] Uploading final.mp4 to bucket as ${videoKey}`);
      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: videoKey,
        Body: videoData,
        ACL: 'public-read',
        ContentType: 'video/mp4'
      }));

      // --- Step 9: Cleanup local files ---
      setTimeout(() => {
        try {
          console.log('[CLEANUP] Removing temp job folder:', workDir);
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch (e) { console.error('[CLEANUP ERROR]', e); }
      }, 60000); // wait 1 min

      console.log('[DONE] Video processing complete:', videoKey);
      progress[jobId] = { percent: 100, status: "Done! Click play.", key: videoKey };
      finished = true;
      clearTimeout(watchdog);
    } catch (err) {
      console.error('[FAIL] Job failed:', err);
      progress[jobId] = { percent: 100, status: "Failed: " + (err.message || err), error: err.message || err };
      cleanupJob(jobId);
      finished = true;
      clearTimeout(watchdog);
    }
  })();
});

function cleanupJob(jobId) {
  setTimeout(() => {
    if (progress[jobId]) delete progress[jobId];
    console.log('[CLEANUP] Job progress removed for:', jobId);
  }, 4 * 60 * 1000);
}

// ---- Progress polling ----
app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  res.json(progress[jobId] || { percent: 100, status: "Expired." });
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
