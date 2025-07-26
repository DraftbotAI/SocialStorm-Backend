/* ============================================================
   SECTION 1: IMPORTS & GLOBAL SETUP
   -----------------------------------------------------------
   - Requires (express, uuid, ffmpeg, dotenv, AWS, helpers, etc.)
   - Global config, ENV vars, CORS, JSON parsing
   =========================================================== */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const AWS = require('aws-sdk');
const axios = require('axios');
const { Readable } = require('stream');
const morgan = require('morgan');
const { POLLY_VOICE_IDS, ELEVENLABS_VOICE_IDS } = require('./pexels-helper.cjs');
const PEXELS_HELPER = require('./pexels-helper.cjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

const progress = {}; // Track video generation jobs
const CLEANUP_TIMEOUT = 15 * 60 * 1000; // 15 min

const OUTRO_CLIP = process.env.OUTRO_CLIP || path.join(__dirname, 'assets', 'outro.mp4');
const WATERMARK_FILE = process.env.WATERMARK_FILE || path.join(__dirname, 'assets', 'watermark.png');
const MUSIC_DIR = process.env.MUSIC_DIR || path.join(__dirname, 'music');
const TEMP_DIR = process.env.TEMP_DIR || path.join(__dirname, 'tmp');

// Polly config
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'us-east-1',
});
const Polly = new AWS.Polly();

// ElevenLabs config
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

function log(...args) {
  console.log('[LOG]', ...args);
}

/* ============================================================
   SECTION 2: UTILITY FUNCTIONS & JOB MGMT
   -----------------------------------------------------------
   - Progress tracking, job cleanup, file safety
   =========================================================== */

function safeFilePath(filepath) {
  if (!filepath || filepath.includes('..')) throw new Error('Unsafe path: ' + filepath);
  return filepath;
}

function cleanupJob(jobId) {
  if (!progress[jobId]) return;
  // Clean up temp files later if needed
  delete progress[jobId];
}

function formatError(err) {
  return (err && err.stack) ? err.stack : String(err);
}

/* ============================================================
   SECTION 3: VOICES ENDPOINTS
   -----------------------------------------------------------
   - Returns all available voices with metadata
   =========================================================== */

const VOICES = [
  // FREE TIER: Amazon Polly
  { id: 'polly-matthew', name: 'Matthew', description: 'Natural warm American male (Free Tier)', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-matthew.mp3', disabled: false },
  { id: 'polly-joanna', name: 'Joanna', description: 'Friendly American female (Free Tier)', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-joanna.mp3', disabled: false },
  { id: 'polly-joey', name: 'Joey', description: 'American male, energetic', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-joey.mp3', disabled: false },
  { id: 'polly-kimberly', name: 'Kimberly', description: 'Bright, young American female', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-kimberly.mp3', disabled: false },
  { id: 'polly-brian', name: 'Brian', description: 'Warm British male', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-brian.mp3', disabled: false },
  { id: 'polly-russell', name: 'Russell', description: 'Chill, smooth Australian male', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-russell.mp3', disabled: false },
  { id: 'polly-amy', name: 'Amy', description: 'Polished, clear British female', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-amy.mp3', disabled: false },
  { id: 'polly-salli', name: 'Salli', description: 'Bright, clean American female', tier: 'Free', provider: 'Amazon Polly', preview: '/assets/voices/polly-salli.mp3', disabled: false },

  // PREMIUM: ElevenLabs, etc.
  { id: 'eleven-mike', name: 'Mike', description: 'Bold, viral, American (Pro)', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-mike.mp3', disabled: false },
  { id: 'eleven-jackson', name: 'Jackson', description: 'Edgy, YouTube style (Pro)', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-jackson.mp3', disabled: false },
  { id: 'eleven-olivia', name: 'Olivia', description: 'Warm, millennial female', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-olivia.mp3', disabled: false },
  { id: 'eleven-emily', name: 'Emily', description: 'Calm, clear female (Pro)', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-emily.mp3', disabled: false },
  { id: 'eleven-tyler', name: 'Tyler', description: 'Chill, relaxed, youth', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-tyler.mp3', disabled: false },
  { id: 'eleven-james', name: 'James', description: 'Wise, deep, narrator', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-james.mp3', disabled: false },
  { id: 'eleven-amelia', name: 'Amelia', description: 'Young, fun, fast-talker', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-amelia.mp3', disabled: false },
  { id: 'eleven-pierre', name: 'Pierre', description: 'European, stylish, unique', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-pierre.mp3', disabled: false },
  { id: 'eleven-claire', name: 'Claire', description: 'French, fashion, fun', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-claire.mp3', disabled: false },
  { id: 'eleven-diego', name: 'Diego', description: 'Spanish, upbeat, fun', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-diego.mp3', disabled: false },
  { id: 'eleven-lucia', name: 'Lucia', description: 'Spanish, millennial female', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-lucia.mp3', disabled: false },
  // ASMR, Pro, etc (examples, update as needed)
  { id: 'eleven-aimee-asmr-pro', name: 'Aimee (ASMR Pro)', description: 'Soothing, gentle ASMR', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-aimee-asmr.mp3', disabled: false },
  { id: 'eleven-dr-lovelace-asmr-pro', name: 'Dr. Lovelace (ASMR Pro)', description: 'Chill, ASMR, science', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-dr-lovelace-asmr.mp3', disabled: false },
  { id: 'eleven-james-whitmore-asmr-pro', name: 'James Whitmore (ASMR Pro)', description: 'Classic ASMR, older male', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-james-whitmore-asmr.mp3', disabled: false },
  { id: 'eleven-aimee-asmr-gentle', name: 'Aimee (ASMR Gentle)', description: 'Gentle, sleep, soft-spoken', tier: 'Pro', provider: 'ElevenLabs', preview: '/assets/voices/eleven-aimee-gentle.mp3', disabled: false },
];

app.get('/api/voices', (req, res) => {
  log('GET /api/voices');
  res.json({ success: true, voices: VOICES });
});

/* ============================================================
   SECTION 4: SCRIPT GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-script
   - Uses GPT for script + metadata
   =========================================================== */

app.post('/api/generate-script', async (req, res) => {
  log('POST /api/generate-script', req.body);
  // --- Example GPT usage, update to match your GPT flow ---
  // For now, just echo
  const { idea } = req.body;
  if (!idea || idea.length < 3) {
    return res.json({ success: false, error: 'Please enter a valid idea.' });
  }
  // TODO: Replace with GPT-4.1 script generator logic
  // Dummy output:
  const script = `${idea}.\nHere is line 2.\nHere is line 3.`;
  const meta = { title: 'Sample Title', tags: ['sample', 'tag'], description: 'Sample description.' };
  res.json({ success: true, script, meta });
});

/* ============================================================
   SECTION 5: VIDEO GENERATION ENDPOINT
   -----------------------------------------------------------
   - POST /api/generate-video
   - Main generation logic, scene logic, voice, video, music, outro
   =========================================================== */

app.post('/api/generate-video', async (req, res) => {
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  res.json({ jobId });

  (async () => {
    log(`[JOB:${jobId}] Video generation started.`);
    try {
      const { script, voiceId, branding, watermark, music, userId } = req.body;
      if (!script || !voiceId) throw new Error('Missing script or voice');

      // --- 1. Parse script into scenes ---
      let scenes = script.split(/\n|\r|\./).map(s => s.trim()).filter(Boolean);
      log(`[JOB:${jobId}] Parsed scenes:`, scenes);
      if (scenes.length < 2) throw new Error('Script too short. Enter more lines.');

      // --- 2. Find "main topic" for scene 1 matching (usually subject of scene 2) ---
      let mainSubject = await PEXELS_HELPER.extractMainSubject(scenes[1] || scenes[0]);
      let usedClips = new Set();
      let sceneFiles = [];

      // --- 3. Generate all scenes: voice, clip, sync ---
      for (let i = 0; i < scenes.length; ++i) {
        const line = scenes[i];
        log(`[JOB:${jobId}] Generating scene ${i + 1}: ${line}`);
        // 3a. Select subject for this scene (first scene = main topic)
        let searchSubject = (i === 0) ? mainSubject : await PEXELS_HELPER.extractMainSubject(line);
        let { clipPath, clipSource } = await PEXELS_HELPER.findClipSmart(searchSubject, usedClips);
        usedClips.add(clipPath);
        log(`[JOB:${jobId}] Clip for scene ${i + 1}:`, clipPath, `(source=${clipSource})`);
        // 3b. Generate TTS audio
        let audioPath;
        if (voiceId.startsWith('polly-')) {
          audioPath = await synthPolly(line, voiceId);
        } else if (voiceId.startsWith('eleven-')) {
          audioPath = await synthElevenLabs(line, voiceId);
        } else {
          throw new Error('Invalid voice ID: ' + voiceId);
        }
        // 3c. Trim clip to match audio
        const trimmedClip = await trimVideoToAudio(clipPath, audioPath, jobId, i);
        // 3d. Overlay voice on video
        const sceneOut = path.join(TEMP_DIR, `${jobId}_scene${i + 1}.mp4`);
        await combineAudioWithVideo(trimmedClip, audioPath, sceneOut);
        sceneFiles.push(sceneOut);
        progress[jobId] = { percent: Math.floor((i + 1) / scenes.length * 60), status: `Scene ${i + 1} of ${scenes.length}` };
      }

      // --- 4. Concatenate all scenes into base video ---
      const concatListPath = path.join(TEMP_DIR, `${jobId}_concat.txt`);
      fs.writeFileSync(concatListPath, sceneFiles.map(f => `file '${f}'`).join('\n'));
      const baseOut = path.join(TEMP_DIR, `${jobId}_base.mp4`);
      await concatVideos(concatListPath, baseOut);
      progress[jobId] = { percent: 70, status: 'Scenes stitched' };

      // --- 5. Add background music (ends before outro) ---
      let musicFile = await pickMusic(scenes);
      if (musicFile) {
        log(`[JOB:${jobId}] Adding background music: ${musicFile}`);
        const musicOut = path.join(TEMP_DIR, `${jobId}_music.mp4`);
        await addBackgroundMusic(baseOut, musicFile, musicOut, scenes.length, jobId);
        fs.renameSync(musicOut, baseOut);
        progress[jobId] = { percent: 80, status: 'Music added' };
      } else {
        log(`[JOB:${jobId}] No music file found. Skipping music overlay.`);
      }

      // --- 6. Add outro ---
      const withOutro = path.join(TEMP_DIR, `${jobId}_with_outro.mp4`);
      await addOutro(baseOut, OUTRO_CLIP, withOutro);
      progress[jobId] = { percent: 88, status: 'Outro added' };

      // --- 7. Add watermark if needed ---
      let finalOut = withOutro;
      if (branding !== true && watermark !== false) {
        const watermarked = path.join(TEMP_DIR, `${jobId}_watermarked.mp4`);
        await addWatermark(withOutro, WATERMARK_FILE, watermarked);
        finalOut = watermarked;
        progress[jobId] = { percent: 96, status: 'Watermark applied' };
      }

      // --- 8. Job complete, save final output ---
      const outputUrl = `/video/${path.basename(finalOut)}`;
      progress[jobId] = { percent: 100, status: 'Complete', url: outputUrl };
      log(`[JOB:${jobId}] Video complete: ${outputUrl}`);
      cleanupJob(jobId);
    } catch (err) {
      log(`[JOB:${jobId}] ERROR:`, formatError(err));
      progress[jobId] = { percent: 100, status: 'Failed: ' + formatError(err) };
      cleanupJob(jobId);
    }
  })();
});

/* ============================================================
   SECTION 6: PROGRESS ENDPOINT
   -----------------------------------------------------------
   - /api/progress/:jobId — status for jobs
   =========================================================== */

app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  res.json(progress[jobId] || { percent: 100, status: 'Unknown job' });
});

/* ============================================================
   SECTION 7: CLIP MATCHING, SCENE HELPERS
   -----------------------------------------------------------
   - GPT-powered matcher, fallback logic, dupe prevention
   =========================================================== */

async function synthPolly(text, voiceId) {
  // Extract Polly voice name
  const name = voiceId.replace('polly-', '');
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: name,
  };
async function synthPolly(text, voiceId) {
  const name = voiceId.replace('polly-', '');
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: name,
  };
  const { AudioStream } = await Polly.synthesizeSpeech(params).promise();
  const outPath = path.join(TEMP_DIR, `polly_${uuidv4()}.mp3`);
  fs.writeFileSync(outPath, AudioStream);
  log(`[TTS] Polly audio saved: ${outPath}`);
  return outPath;
}

async function synthElevenLabs(text, voiceId) {
  // Map SocialStorm voiceId to ElevenLabs
  const voiceKey = voiceId.replace('eleven-', '');
  const elevenId = ELEVENLABS_VOICE_IDS[voiceKey] || voiceKey;
  const url = `${ELEVENLABS_API_URL}/${elevenId}`;
  const resp = await axios.post(url, {
    text,
    voice_settings: { stability: 0.6, similarity_boost: 0.8 }
  }, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'accept': 'audio/mpeg',
      'Content-Type': 'application/json',
    },
    responseType: 'arraybuffer',
  });
  const outPath = path.join(TEMP_DIR, `11labs_${uuidv4()}.mp3`);
  fs.writeFileSync(outPath, resp.data);
  log(`[TTS] ElevenLabs audio saved: ${outPath}`);
  return outPath;
}

async function trimVideoToAudio(clipPath, audioPath, jobId, idx) {
  return new Promise((resolve, reject) => {
    // Get audio duration
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) return reject(err);
      const dur = data.format.duration;
      const trimmedOut = path.join(TEMP_DIR, `${jobId}_scene${idx + 1}_trim.mp4`);
      ffmpeg(clipPath)
        .setStartTime(0)
        .setDuration(dur)
        .outputOptions('-y')
        .save(trimmedOut)
        .on('end', () => {
          log(`[SCENE] Trimmed clip to ${dur}s: ${trimmedOut}`);
          resolve(trimmedOut);
        })
        .on('error', reject);
    });
  });
}

async function combineAudioWithVideo(video, audio, outFile) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(video)
      .input(audio)
      .outputOptions([
        '-c:v copy',
        '-map 0:v:0',
        '-map 1:a:0',
        '-shortest',
        '-y'
      ])
      .save(outFile)
      .on('end', () => {
        log(`[SCENE] Combined video+audio: ${outFile}`);
        resolve();
      })
      .on('error', reject);
  });
}

async function concatVideos(txtFile, outFile) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(txtFile)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-y'])
      .save(outFile)
      .on('end', () => {
        log(`[CONCAT] All scenes joined: ${outFile}`);
        resolve();
      })
      .on('error', reject);
  });
}

async function addBackgroundMusic(videoFile, musicFile, outFile, sceneCount, jobId) {
  // Calculate music duration (exclude outro)
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoFile, (err, data) => {
      if (err) return reject(err);
      let totalDuration = data.format.duration;
      // Optional: subtract last scene duration if outro is known
      // To keep it simple, fade out music 2s before end
      let musicDur = totalDuration > 2 ? totalDuration - 2 : totalDuration;
      ffmpeg()
        .input(videoFile)
        .input(musicFile)
        .complexFilter([
          '[1:a]volume=0.13,afade=t=out:st=' + (musicDur - 2) + ':d=2[m1]',
          '[0:a][m1]amix=inputs=2:duration=shortest[aout]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [aout]',
          '-c:v copy',
          '-shortest',
          '-y'
        ])
        .save(outFile)
        .on('end', () => {
          log(`[MUSIC] Music added: ${outFile}`);
          resolve();
        })
        .on('error', reject);
    });
  });
}

async function addOutro(videoFile, outroFile, outFile) {
  return new Promise((resolve, reject) => {
    // Concat videoFile + outroFile
    const concatList = path.join(TEMP_DIR, `concat_${uuidv4()}.txt`);
    fs.writeFileSync(concatList, `file '${videoFile}'\nfile '${outroFile}'`);
    ffmpeg()
      .input(concatList)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy', '-y'])
      .save(outFile)
      .on('end', () => {
        log(`[OUTRO] Outro added: ${outFile}`);
        fs.unlinkSync(concatList);
        resolve();
      })
      .on('error', reject);
  });
}

async function addWatermark(inputFile, watermarkFile, outFile) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .input(watermarkFile)
      .complexFilter([
        '[0:v][1:v]overlay=W-w-20:H-h-20:format=auto[v]',
        '[0:a]anull[a]'
      ], ['v', 'a'])
      .outputOptions(['-map [v]', '-map [a]', '-c:v libx264', '-c:a aac', '-shortest', '-y'])
      .save(outFile)
      .on('end', () => {
        log(`[WATERMARK] Watermark applied: ${outFile}`);
        resolve();
      })
      .on('error', reject);
  });
}

async function pickMusic(scenes) {
  // Pick music file based on tone (stub: pick random for now)
  const files = fs.readdirSync(MUSIC_DIR).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
  if (!files.length) return null;
  // TODO: Use GPT-4.1 to score tone and pick better match
  const file = files[Math.floor(Math.random() * files.length)];
  return path.join(MUSIC_DIR, file);
}

/* ============================================================
   SECTION 8: CONTACT FORM ENDPOINT
   -----------------------------------------------------------
   - POST /api/contact
   =========================================================== */

app.post('/api/contact', async (req, res) => {
  const { name = '', email = '', message = '' } = req.body;
  if (!name || !email || !message) {
    return res.json({ success: false, error: "Please fill out all fields." });
  }
  log(`[CONTACT] ${name} <${email}>: ${message}`);
  // Email sending logic here if needed
  res.json({ success: true });
});

/* ============================================================
   SECTION 9: VIDEO FILE SERVE ENDPOINT
   -----------------------------------------------------------
   - Serves final .mp4 from disk (or cloud in future)
   =========================================================== */

app.get('/video/:file', (req, res) => {
  try {
    const file = safeFilePath(req.params.file);
    const fullPath = path.join(TEMP_DIR, file);
    if (!fs.existsSync(fullPath)) {
      res.status(404).send('Not found');
    } else {
      res.sendFile(fullPath);
    }
  } catch (e) {
    res.status(400).send('Invalid file');
  }
});

/* ============================================================
   SECTION 10: THUMBNAIL GENERATION (NOT YET IMPLEMENTED)
   -----------------------------------------------------------
   - /api/generate-thumbnails stub
   =========================================================== */

app.post('/api/generate-thumbnails', (req, res) => {
  res.json({ success: false, error: 'Not implemented' });
});

/* ============================================================
   SECTION 11: MISC/MAINTENANCE & HEALTHCHECK
   -----------------------------------------------------------
   - Healthcheck & fallback routes
   =========================================================== */

app.get('/api/status', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).send('Route not found.');
});

/* ============================================================
   SECTION 12: SERVER STARTUP
   -----------------------------------------------------------
   - app.listen
   =========================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`SocialStormAI backend running on port ${PORT}`);
});

// END FULL SERVER CODE
