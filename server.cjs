/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   -----------------------------------------------------------
   - Load env, modules, API keys, paths
   - Configure AWS + Cloudflare R2 + OpenAI + FFmpeg
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
const fsExtra = require('fs-extra');
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[INFO] FFmpeg path set to:', ffmpegPath);

const { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const AWS = require('aws-sdk');

// === OPENAI CLIENT SETUP ===
let openai;
try {
  const OpenAI = require('openai');
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
  console.log('[INFO] OpenAI client initialized.');
} catch (err) {
  console.error('[FATAL] OpenAI client setup failed:', err);
  process.exit(1);
}

// === R2 / S3 BUCKETS & CLIENT SETUP ===
// Loads both library (clips) and output (videos) buckets
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_VIDEOS_BUCKET = process.env.R2_VIDEOS_BUCKET || 'socialstorm-videos';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_KEY;

// ---- S3Client for Cloudflare R2 ----
const s3Client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});
console.log('[INFO] Cloudflare R2 S3Client initialized.');
console.log('[INFO] R2_LIBRARY_BUCKET:', R2_LIBRARY_BUCKET);
console.log('[INFO] R2_VIDEOS_BUCKET:', R2_VIDEOS_BUCKET);
console.log('[INFO] R2_ENDPOINT:', R2_ENDPOINT);

// === JOBS DIR DEFINITION (for temp/progress management) ===
const JOBS_DIR = path.join(__dirname, 'jobs');

console.log('[INFO] Dependencies loaded.');

// === ENV CHECK ===
const requiredEnvVars = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'R2_LIBRARY_BUCKET',
  'R2_VIDEOS_BUCKET',
  'R2_ENDPOINT',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY'
];
const missingEnv = requiredEnvVars.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  console.error('[FATAL] Missing environment variables:', missingEnv);
  process.exit(1);
}
console.log('[INFO] All required environment variables are present.');

// ==== AWS CONFIG ====
// (Still needed for Polly TTS, must explicitly use 'us-east-1')
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1'
});
console.log('[INFO] AWS SDK configured for Polly, region:', process.env.AWS_REGION);

// ==== EXPRESS INIT ====
const app = express();

app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));

// ==== JOB PROGRESS MAP ====
const progress = {};
console.log('[INFO] Progress tracker initialized.');

// ==== LOAD HELPERS ====
// ✅ Uses pexels-helper.cjs with only the available functions
const {
  splitScriptToScenes,
  findClipForScene
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

// ---- EXPORT any needed shared objects for later sections ----
module.exports = {
  app,
  progress,
  s3Client,
  R2_LIBRARY_BUCKET,
  R2_VIDEOS_BUCKET,
  R2_ENDPOINT,
  JOBS_DIR,
  splitScriptToScenes,
  findClipForScene,
  cleanupJob,
  openai
};





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

// =====================================================
// SCENE TTS GENERATOR: POLLY OR ELEVENLABS (HELPER)
// =====================================================

async function generateSceneAudio(text, voiceId, outputPath, ttsProvider) {
  console.log(`[TTS] Generating audio with provider: ${ttsProvider}, voice: ${voiceId}`);

  if (ttsProvider.toLowerCase() === 'polly' || ttsProvider === 'Amazon Polly') {
    // --- AWS Polly TTS ---
    const polly = new AWS.Polly({
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION
    });
    const params = {
      OutputFormat: 'mp3',
      Text: text,
      VoiceId: voiceId.replace('polly-', ''), // e.g., "polly-Matthew" → "Matthew"
      Engine: 'neural'
    };
    const data = await polly.synthesizeSpeech(params).promise();
    fs.writeFileSync(outputPath, data.AudioStream);
    console.log(`[TTS] Polly audio saved: ${outputPath}`);
    return outputPath;
  }

  if (ttsProvider.toLowerCase() === 'elevenlabs') {
    // --- ElevenLabs TTS ---
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: 'eleven_monolingual_v1' },
      {
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        responseType: 'arraybuffer'
      }
    );
    fs.writeFileSync(outputPath, res.data);
    console.log(`[TTS] ElevenLabs audio saved: ${outputPath}`);
    return outputPath;
  }

  throw new Error(`Unknown TTS provider: ${ttsProvider}`);
}

// =====================================================
// REMOTE VIDEO FILE DOWNLOADER (HELPER)
// =====================================================

/**
 * Downloads a remote file (video) to a local path.
 * @param {string} url - The URL to download.
 * @param {string} dest - Local path to save to.
 * @returns {Promise<string>} - Resolves to dest if successful.
 */
async function downloadRemoteFileToLocal(url, dest) {
  console.log(`[DL] Downloading remote file: ${url} → ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const writer = fs.createWriteStream(dest);
  const response = await axios.get(url, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let finished = false;
    writer.on('finish', () => {
      finished = true;
      console.log(`[DL] Download complete: ${dest}`);
      resolve(dest);
    });
    writer.on('error', err => {
      if (!finished) {
        console.error(`[DL] Download error:`, err);
        reject(err);
      }
    });
  });
}

// =====================================================
// COMBINE AUDIO + VIDEO INTO ONE SCENE (HELPER)
// =====================================================

/**
 * Combines audio and video into a single output video using ffmpeg.
 * @param {string} audioPath - Path to the .mp3 audio file.
 * @param {string} videoPath - Path to the downloaded video file.
 * @param {string} outputPath - Where to save the combined scene video.
 */
async function combineAudioAndVideo(audioPath, videoPath, outputPath) {
  console.log(`[FFMPEG] Combining audio (${audioPath}) + video (${videoPath}) → ${outputPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-c:v copy',
        '-c:a aac',
        '-shortest',
        '-y'
      ])
      .save(outputPath)
      .on('end', () => {
        console.log(`[FFMPEG] Scene combined: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[FFMPEG] Combine error:`, err);
        reject(err);
      });
  });
}

// =====================================================
// CONCATENATE ALL SCENE VIDEOS INTO FINAL VIDEO (HELPER)
// =====================================================

/**
 * Concatenates multiple scene videos into one using ffmpeg concat demuxer.
 * @param {string[]} scenePaths - Array of full paths to scene videos (in order).
 * @param {string} outputPath - Where to save the stitched video.
 */
async function stitchScenes(scenePaths, outputPath) {
  console.log(`[FFMPEG] Stitching scenes: ${scenePaths.length} → ${outputPath}`);
  const tempListFile = outputPath + '.txt';
  fs.writeFileSync(
    tempListFile,
    scenePaths.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  );
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(tempListFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c:v copy', '-c:a aac', '-movflags +faststart'])
      .save(outputPath)
      .on('end', () => {
        fs.unlinkSync(tempListFile);
        console.log(`[FFMPEG] Scenes stitched to: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[FFMPEG] Stitch error:`, err);
        if (fs.existsSync(tempListFile)) fs.unlinkSync(tempListFile);
        reject(err);
      });
  });
}

// =====================================================
// FINAL TOUCHES: WATERMARK / OUTRO / MUSIC (HELPER)
// =====================================================

/**
 * Applies watermark, outro, and/or background music to final stitched video.
 * - watermark: boolean, overlay logo at bottom-right
 * - outro: boolean, placeholder (no-op for now)
 * - backgroundMusic: boolean, placeholder (no-op for now)
 *
 * @param {string} inputPath - Path to stitched video.
 * @param {string} outputPath - Where to save final output.
 * @param {Object} opts - Options { watermark, outro, backgroundMusic }
 */
async function addFinalTouches(inputPath, outputPath, opts = {}) {
  console.log(`[STEP] Adding final touches: watermark=${!!opts.watermark}, outro=${!!opts.outro}, bgm=${!!opts.backgroundMusic}`);
  let cmd = ffmpeg().input(inputPath);

  // === Watermark ===
  if (opts.watermark) {
    const watermarkPath = path.join(__dirname, 'public', 'logo.png');
    if (!fs.existsSync(watermarkPath)) {
      console.warn('[WATERMARK] Logo not found:', watermarkPath);
      // fallback: just copy
      fs.copyFileSync(inputPath, outputPath);
      return outputPath;
    }
    cmd = cmd.input(watermarkPath)
      .complexFilter([
        '[0:v][1:v]overlay=W-w-40:H-h-40' // logo bottom right, adjust offset as needed
      ]);
  }

  // === Outro ===
  // Placeholder: no-op for now (can append in future version)

  // === Background Music ===
  // Placeholder: no-op for now (can add bg music layer here)

  return new Promise((resolve, reject) => {
    cmd
      .outputOptions(['-c:v libx264', '-c:a aac', '-pix_fmt yuv420p', '-movflags +faststart'])
      .save(outputPath)
      .on('end', () => {
        console.log(`[FINAL] Final video with touches saved: ${outputPath}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error(`[FINAL] Final touches error:`, err);
        reject(err);
      });
  });
}




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
   =========================================================== */

console.log('[INFO] Registering /api/generate-script endpoint...');

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
    const prompt = `
You are a viral YouTube Shorts scriptwriter.
Write a viral script about: ${idea}
Rules:
- Line 1 must be a dramatic or funny HOOK (attention-grabber about the *theme*).
- Each line = one scene, short and punchy, no dialogue, no numbers, no tags.
- 6–10 lines total, each line is a separate scene.
- No quotes, emojis, hashtags, or scene numbers.
- After script lines, output:
Title: [viral title, no quotes]
Description: [short SEO description, no hashtags]
Tags: [max 5, space-separated, no hashtags or commas]
Example:
Did you know famous landmarks hide wild secrets?
...
Title: The Wildest Secret Rooms Inside Landmarks
Description: Uncover the wildest secret spaces hidden inside the world’s most famous landmarks.
Tags: secrets landmarks travel viral history
    `.trim();

    // === OpenAI v4+ call ===
    const completion = await openai.chat.completions.create({
      model: "gpt-4-1106-preview",
      temperature: 0.84,
      max_tokens: 900,
      messages: [
        { role: "system", content: prompt }
      ]
    });

    const raw = completion?.choices?.[0]?.message?.content?.trim() || '';
    console.log('[GPT] Raw output:\n' + raw);

    // === Parse Output ===
    let scriptLines = [];
    let title = '';
    let description = '';
    let tags = '';

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const titleIdx = lines.findIndex(l => /^title\s*:/i.test(l));
    const descIdx  = lines.findIndex(l => /^description\s*:/i.test(l));
    const tagsIdx  = lines.findIndex(l => /^tags?\s*:/i.test(l));

    const metaStart = [titleIdx, descIdx, tagsIdx].filter(x => x > -1).sort((a,b) => a - b)[0] || lines.length;
    scriptLines = lines.slice(0, metaStart).filter(l =>
      !/^title\s*:/i.test(l) && !/^description\s*:/i.test(l) && !/^tags?\s*:/i.test(l)
    );
    if (scriptLines.length > 10) scriptLines = scriptLines.slice(0, 10);

    for (const l of lines.slice(metaStart)) {
      if (/^title\s*:/i.test(l)) title = l.replace(/^title\s*:/i, '').trim();
      else if (/^description\s*:/i.test(l)) description = l.replace(/^description\s*:/i, '').trim();
      else if (/^tags?\s*:/i.test(l)) tags = l.replace(/^tags?\s*:/i, '').trim();
    }

    if (!title) title = idea.length < 60 ? idea : idea.slice(0, 57) + "...";
    if (!description) description = `Here's a quick look at "${idea}" – stay tuned.`;
    if (!tags) tags = "shorts viral";

    if (!scriptLines.length) scriptLines = ['Something went wrong generating the script.'];

    console.log('[PARSED] script lines:', scriptLines.length, scriptLines);
    console.log('[PARSED] title:', title);
    console.log('[PARSED] description:', description);
    console.log('[PARSED] tags:', tags);

    res.json({
      success: true,
      script: scriptLines.join('\n'),
      title,
      description,
      tags
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

// Helper: Get audio duration in seconds using ffprobe
const getAudioDuration = (audioPath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
};

// Helper: Trim video to [duration] seconds (with optional offset)
const trimVideo = (inPath, outPath, duration, seek = 0) => {
  return new Promise((resolve, reject) => {
    // Ensure output dir exists
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    // Build the correct FFmpeg command: use -ss before -i for fast seek, encode for accurate trim
    const ffmpegArgs = [
      '-ss', String(seek),
      '-i', path.resolve(inPath),
      '-t', String(duration),
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      path.resolve(outPath)
    ];
    console.log(`[FFMPEG][TRIM] ffmpeg ${ffmpegArgs.join(' ')}`);
    const ff = require('child_process').spawn('ffmpeg', ffmpegArgs);

    ff.stderr.on('data', d => process.stderr.write(d));
    ff.on('exit', (code) => {
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        resolve(outPath);
      } else {
        reject(new Error(`FFmpeg trim failed, exit code ${code}`));
      }
    });
  });
};

// Helper: Overlay audio onto video, start audio at +0.5s
const combineAudioVideoWithOffsets = async (videoPath, audioPath, outPath, leadIn = 0.5, tail = 1) => {
  // Ensure output dir exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const audioDuration = await getAudioDuration(audioPath);
  const totalDuration = leadIn + audioDuration + tail;
  // Compose filter for offset and mix
  const filter = [
    `[1:a]adelay=${Math.round(leadIn * 1000)}|${Math.round(leadIn * 1000)},apad,atrim=0:${totalDuration}[aud];`,
    `[0:a]apad,atrim=0:${totalDuration}[vad];`,
    `[0:v]trim=duration=${totalDuration},setpts=PTS-STARTPTS[vid];`,
    `[vid][vad][aud]amix=inputs=2:duration=first[aout]`
  ].join('');
  console.log(`[FFMPEG][COMBINE] Mixing audio and video for scene.\n    Video: ${videoPath}\n    Audio: ${audioPath}\n    Out:   ${outPath}\n    Filter: ${filter}`);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.resolve(videoPath))
      .input(path.resolve(audioPath))
      .complexFilter([filter], ['vid', 'aout'])
      .outputOptions([
        '-map', '[vid]',
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-shortest',
        '-movflags', '+faststart',
        '-y'
      ])
      .duration(totalDuration)
      .save(path.resolve(outPath))
      .on('end', () => {
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
          resolve(outPath);
        } else {
          reject(new Error(`FFmpeg combine produced no output`));
        }
      })
      .on('error', reject);
  });
};

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
      const {
        script = '',
        voice = '',
        paidUser = false,
        removeWatermark = false,
        title = '',
        backgroundMusic = true
      } = req.body || {};

      console.log(`[STEP] Inputs parsed. Voice: ${voice} | Paid: ${paidUser} | Remove WM: ${removeWatermark} | Music: ${backgroundMusic}`);
      console.log(`[DEBUG] Raw script:\n${script}`);

      // === Validation ===
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: Missing script or voice.' };
        cleanupJob(jobId); clearTimeout(watchdog);
        return;
      }

      const selectedVoice = voices.find(v => v.id === voice);
      const ttsProvider = selectedVoice ? selectedVoice.provider : null;

      if (!ttsProvider) {
        progress[jobId] = { percent: 100, status: `Failed: Unknown voice (${voice})` };
        cleanupJob(jobId); clearTimeout(watchdog);
        return;
      }

      if (ttsProvider.toLowerCase() === 'polly' && !POLLY_VOICE_IDS.includes(voice)) {
        progress[jobId] = { percent: 100, status: `Failed: Invalid Polly voice (${voice})` };
        cleanupJob(jobId); clearTimeout(watchdog);
        return;
      }

      const workDir = path.resolve(__dirname, 'renders', jobId);
      fs.mkdirSync(workDir, { recursive: true });
      console.log(`[STEP] Work dir created: ${workDir}`);

      const scenes = splitScriptToScenes(script);
      if (!scenes.length) {
        progress[jobId] = { percent: 100, status: 'Failed: No scenes from script' };
        cleanupJob(jobId); clearTimeout(watchdog);
        return;
      }
      console.log(`[STEP] Script split into ${scenes.length} scenes.`);

      let sceneFiles = [];
      let line2Subject = scenes[1]?.text || '';
      let sharedClipUrl = null;

      // === Pre-pick video for scene 1 & 2 using line 2's subject ===
      try {
        sharedClipUrl = await findClipForScene(line2Subject, 1, scenes.map(s => s.text), title || '');
        console.log(`[SCENE 1&2] Selected shared clip for hook/scene2: ${sharedClipUrl}`);
      } catch (err) {
        console.error(`[ERR] Could not select shared video clip for scenes 1 & 2`, err);
      }

      for (let i = 0; i < scenes.length; i++) {
        const { id: sceneId, text: sceneText } = scenes[i];
        const base = sceneId;
        const audioPath = path.resolve(workDir, `${base}-audio.mp3`);
        const rawVideoPath = path.resolve(workDir, `${base}-rawvideo.mp4`);
        const trimmedVideoPath = path.resolve(workDir, `${base}-trimmed.mp4`);
        const sceneMp4 = path.resolve(workDir, `${base}.mp4`);

        progress[jobId] = {
          percent: Math.floor((i / scenes.length) * 65),
          status: `Working on scene ${i + 1} of ${scenes.length}...`
        };
        console.log(`[SCENE] Working on scene ${i + 1}/${scenes.length}: "${sceneText}"`);

        // === Generate audio ===
        try {
          await generateSceneAudio(sceneText, voice, audioPath, ttsProvider);
          if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1024) {
            throw new Error(`Audio output missing or too small: ${audioPath}`);
          }
          console.log(`[AUDIO] Scene ${i + 1} audio created: ${audioPath}`);
        } catch (err) {
          console.error(`[ERR] Audio generation failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Audio generation error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        // === Pick correct video ===
        let clipUrl = null;
        if (i === 0 || i === 1) {
          clipUrl = sharedClipUrl;
        } else {
          try {
            clipUrl = await findClipForScene(sceneText, i, scenes.map(s => s.text), title || '');
          } catch (err) {
            console.error(`[ERR] Clip matching failed for scene ${i + 1}`, err);
          }
        }

        if (!clipUrl) {
          progress[jobId] = { percent: 100, status: `Failed: No video found for scene ${i + 1}` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        // === Download video ===
        try {
          await downloadRemoteFileToLocal(clipUrl, rawVideoPath);
          if (!fs.existsSync(rawVideoPath) || fs.statSync(rawVideoPath).size < 10240) {
            throw new Error(`Video output missing or too small: ${rawVideoPath}`);
          }
          console.log(`[VIDEO] Downloaded for scene ${i + 1}: ${rawVideoPath}`);
        } catch (err) {
          console.error(`[ERR] Video download failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Video download error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        // === Trim video to match: 0.5s + [audio duration] + 1s ===
        let audioDuration;
        try {
          audioDuration = await getAudioDuration(audioPath);
          if (!audioDuration || audioDuration < 0.2) throw new Error("Audio duration zero or invalid.");
        } catch (err) {
          console.error(`[ERR] Could not get audio duration for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Audio duration error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }
        const leadIn = 0.5, tail = 1.0;
        const sceneDuration = leadIn + audioDuration + tail;

        try {
          await trimVideo(rawVideoPath, trimmedVideoPath, sceneDuration, 0);
          if (!fs.existsSync(trimmedVideoPath) || fs.statSync(trimmedVideoPath).size < 10240) {
            throw new Error(`Trimmed video missing or too small: ${trimmedVideoPath}`);
          }
          console.log(`[TRIM] Video trimmed for scene ${i + 1}: ${trimmedVideoPath} (${sceneDuration}s)`);
        } catch (err) {
          console.error(`[ERR] Trimming video failed for scene ${i + 1}`, err);
          progress[jobId] = { percent: 100, status: `Failed: Video trim error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }

        // === Overlay audio onto video at 0.5s ===
        try {
          await combineAudioVideoWithOffsets(trimmedVideoPath, audioPath, sceneMp4, leadIn, tail);
          if (!fs.existsSync(sceneMp4) || fs.statSync(sceneMp4).size < 10240) {
            throw new Error(`Combined scene output missing or too small: ${sceneMp4}`);
          }
          sceneFiles.push(sceneMp4);
          console.log(`[COMBINE] Scene ${i + 1} ready for concat: ${sceneMp4}`);
        } catch (err) {
          console.error(`[ERR] Scene combine failed (scene ${i + 1})`, err);
          progress[jobId] = { percent: 100, status: `Failed: Scene combine error (scene ${i + 1})` };
          cleanupJob(jobId); clearTimeout(watchdog); return;
        }
      }

      // === Concatenate scenes using list.txt and ffmpeg concat demuxer ===
      const listFile = path.resolve(workDir, 'list.txt');
      fs.writeFileSync(
        listFile,
        sceneFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
      );
      const concatFile = path.resolve(workDir, 'concat.mp4');

      progress[jobId] = { percent: 75, status: "Combining all scenes together..." };
      console.log(`[CONCAT] Scene list for concat:\n${sceneFiles.join('\n')}`);

      try {
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(listFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
            .save(concatFile)
            .on('end', resolve)
            .on('error', reject);
        });
        if (!fs.existsSync(concatFile) || fs.statSync(concatFile).size < 10240) {
          throw new Error(`Concatenated file missing or too small: ${concatFile}`);
        }
        console.log(`[STITCH] All scenes concatenated: ${concatFile}`);
      } catch (err) {
        console.error(`[ERR] Concatenation failed`, err);
        progress[jobId] = { percent: 100, status: 'Failed: Scene concatenation' };
        cleanupJob(jobId); clearTimeout(watchdog); return;
      }

      // === Watermark, outro, music ===
      const finalPath = path.resolve(workDir, `final.mp4`);
      try {
        progress[jobId] = { percent: 85, status: `Adding outro, watermark, and${backgroundMusic ? '' : ' no'} music...` };

        // -- You may want to adjust these file paths --
        let useWatermark = !(paidUser && removeWatermark);
        const watermarkPath = path.resolve(__dirname, 'frontend', 'logo.png');
        const outroPath = path.resolve(__dirname, 'frontend', 'outro.mp4');
        const addOutro = !removeWatermark;

        let ffmpegCmd = ffmpeg().input(concatFile);

        if (useWatermark && fs.existsSync(watermarkPath)) {
          ffmpegCmd = ffmpegCmd.input(watermarkPath).complexFilter([
            '[1:v]scale=140:140:force_original_aspect_ratio=decrease[wm];[0:v][wm]overlay=W-w-20:H-h-20'
          ]);
        }
        if (addOutro && fs.existsSync(outroPath)) {
          ffmpegCmd = ffmpegCmd.input(outroPath);
          ffmpegCmd = ffmpegCmd.complexFilter([
            ...(useWatermark && fs.existsSync(watermarkPath)
              ? ['[1:v]scale=140:140:force_original_aspect_ratio=decrease[wm];[0:v][wm]overlay=W-w-20:H-h-20[mainv];[mainv][2:v][0:a][2:a]concat=n=2:v=1:a=1[outv][outa]']
              : ['[0:v][1:v][0:a][1:a]concat=n=2:v=1:a=1[outv][outa]']
            )
          ], ['outv', 'outa']);
        }

        ffmpegCmd
          .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
          .save(finalPath);

        await new Promise((resolve, reject) => {
          ffmpegCmd.on('end', resolve).on('error', reject);
        });
        if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 10240) {
          throw new Error(`Final output missing or too small: ${finalPath}`);
        }
        console.log(`[FINAL] Final video written: ${finalPath}`);
      } catch (err) {
        console.error(`[ERR] Final touches failed`, err);
        progress[jobId] = { percent: 100, status: 'Failed: Final touches' };
        cleanupJob(jobId); clearTimeout(watchdog); return;
      }

      // === Save a copy for local serving (ENSURE DIR EXISTS) ===
      fs.mkdirSync(path.resolve(__dirname, 'public', 'video'), { recursive: true });
      const serveCopyPath = path.resolve(__dirname, 'public', 'video', `${jobId}.mp4`);
      fs.copyFileSync(finalPath, serveCopyPath);
      console.log(`[LOCAL SERVE] Video copied to: ${serveCopyPath}`);

      // === Upload to R2 (background, don't block serve) ===
      try {
        const s3Key = `videos/${jobId}.mp4`;
        const fileData = fs.readFileSync(finalPath);
        await s3Client.send(new PutObjectCommand({
          Bucket: process.env.R2_VIDEOS_BUCKET,
          Key: s3Key,
          Body: fileData,
          ContentType: 'video/mp4'
        }));
        console.log(`[UPLOAD] Uploaded final video to R2: ${s3Key}`);
      } catch (err) {
        console.error(`[ERR] R2 upload failed`, err);
        // No need to fail the job if R2 upload fails
      }

      // === Mark job done, point to local copy for instant playback ===
      progress[jobId] = {
        percent: 100,
        status: 'Done',
        key: `${jobId}.mp4` // always accessible locally
      };

      finished = true;
      clearTimeout(watchdog);

      // === Delayed cleanup ===
      setTimeout(() => cleanupJob(jobId), 30 * 60 * 1000);

      console.log(`[DONE] Video job ${jobId} finished and available at /video/${jobId}.mp4`);

    } catch (err) {
      console.error(`[CRASH] Fatal video generation error`, err);
      progress[jobId] = { percent: 100, status: 'Failed: Crash' };
      cleanupJob(jobId); clearTimeout(watchdog);
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
   SECTION 7: VIDEO STREAM ENDPOINT
   -----------------------------------------------------------
   - Serve videos directly from /public/video (local disk)
   - Bulletproof path checking, logs every hit
   =========================================================== */

app.get('/video/:key', (req, res) => {
  const key = req.params.key;
  // Disallow path tricks
  if (!key || typeof key !== 'string' || key.includes('..') || !key.endsWith('.mp4')) {
    console.warn('[VIDEO SERVE] Invalid or missing key:', key);
    return res.status(400).send('Invalid video key');
  }
  const videoPath = path.join(__dirname, 'public', 'video', key);
  fs.stat(videoPath, (err, stats) => {
    if (err || !stats.isFile()) {
      console.warn(`[404] Video not found on disk: ${videoPath}`);
      return res.status(404).send("Video not found");
    }
    console.log(`[SERVE] Sending video: ${videoPath}`);
    res.sendFile(videoPath);
  });
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
