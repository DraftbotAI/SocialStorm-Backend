// ==== SECTION 1: DIRECTORY DEBUGGING (Safe to comment out in prod) ====
console.log('[DEBUG] Entered SECTION 1: DIRECTORY DEBUGGING');
console.log('Working directory:', __dirname);
console.log('Files/folders here:', require('fs').readdirSync(__dirname));

if (require('fs').existsSync(require('path').join(__dirname, 'frontend'))) {
  console.log('Frontend folder contents:', require('fs').readdirSync(require('path').join(__dirname, 'frontend')));
} else {
  console.log('[WARNING] No frontend folder found!');
}

// ==== SECTION 2: ENVIRONMENT & DEPENDENCY SETUP ====
console.log('[DEBUG] Entered SECTION 2: ENVIRONMENT & DEPENDENCY SETUP');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
const { pickClipFor } = require('./pexels-helper.cjs');
const { OpenAI } = require('openai');
const util = require('util');

ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[DEBUG] All dependencies loaded successfully');

// ==== SECTION 3: PROGRESS TRACKING MAP ====
console.log('[DEBUG] Entered SECTION 3: PROGRESS TRACKING MAP');
const progress = {};
const JOB_TTL_MS = 5 * 60 * 1000;

function cleanupJob(jobId, delay = JOB_TTL_MS) {
  console.log('[DEBUG] Cleaning up job:', jobId);
  setTimeout(() => { delete progress[jobId]; console.log('[DEBUG] Job cleaned up:', jobId); }, delay);
}

// ==== SECTION 4: EXPRESS APP INITIALIZATION ====
console.log('[DEBUG] Entered SECTION 4: EXPRESS APP INITIALIZATION');
const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.static(path.join(__dirname, 'frontend')));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/voice-previews', express.static(path.join(__dirname, 'frontend', 'voice-previews')));

const PORT = process.env.PORT || 8080;
console.log('[DEBUG] Express app initialized on port:', PORT);

// ==== SECTION 5: HEALTH CHECK ENDPOINT ====
console.log('[DEBUG] Entered SECTION 5: HEALTH CHECK ENDPOINT');
app.get('/health', (req, res) => {
  console.log('[DEBUG] Health check received');
  res.status(200).send('OK');
});

// ==== SECTION 6: CLOUD R2 CLIENT CONFIGURATION ====
console.log('[DEBUG] Entered SECTION 6: CLOUD R2 CLIENT CONFIGURATION');
const { S3, Endpoint } = AWS;
const s3 = new S3({
  endpoint: new Endpoint(process.env.R2_ENDPOINT),
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'us-east-1',
});
console.log('[DEBUG] Cloud R2 client initialized');

// ==== SECTION 7: HELPERS ====
console.log('[DEBUG] Entered SECTION 7: HELPERS');

// Download file helper
async function downloadToFile(url, outPath) {
  const writer = fs.createWriteStream(outPath);
  const response = await axios.get(url, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    let error = null;
    writer.on('error', err => {
      error = err;
      writer.close();
      reject(err);
    });
    writer.on('close', () => {
      if (!error) resolve();
    });
  });
}

// Function to pick clips from CloudR2 first, then fallback to Pexels and Pixabay
async function pickClipForCloudR2(script, usedUrls = []) {
  console.log('[DEBUG] Checking Cloud R2 for clips...');
  const r2Clips = await s3.listObjectsV2({
    Bucket: process.env.R2_BUCKET,
    Prefix: 'socialstorm-library/',
  }).promise();

  const availableClips = r2Clips.Contents.filter(item => item.Key.endsWith('.mp4'));
  if (availableClips.length > 0) {
    console.log('[DEBUG] Found clip in Cloud R2:', availableClips[0].Key);
    const selectedClip = availableClips[0];
    return { url: `https://${process.env.R2_BUCKET}.r2.cloudflarestorage.com/${selectedClip.Key}`, id: selectedClip.Key };
  }
  console.log('[DEBUG] No clips found in Cloud R2, falling back to Pexels');
  return pickClipFor(script, usedUrls);
}

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
    if (line.toLowerCase().includes("how")) {
      return line;
    }
  }
  return lines[0];
}

// ==== SECTION 8: VIRAL METADATA ENGINE ====
console.log('[DEBUG] Entered SECTION 8: VIRAL METADATA ENGINE');
async function generateViralMetadata({ script, topic, oldTitle, oldDesc }) {
  console.log('[DEBUG] Generating viral metadata for script');
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const metaPrompt = `
You are an expert YouTube Shorts viral strategist. For the following short-form video script and topic, generate:

1. A title that instantly grabs curiosity and clicks. Must be under 65 characters, no all caps, use hooks, emotion, or cliffhanger if possible. If appropriate, add a “How,” “Why,” “Secret,” “Never Knew,” “You’ll Be Shocked,” etc. Use strong SEO keywords and viral language. No generic titles. NO EMOJIS.
2. A 2-3 sentence description that summarizes the video, builds intrigue, and naturally fits SEO keywords. Start with a compelling hook, mention the main subject, and add a soft call to action (“Follow for more,” “Subscribe for wild facts,” etc). NO EMOJIS.
3. A comma-separated stack of 12-16 hashtags, all relevant to the script, topic, and YouTube Shorts virality. Each must start with "#". No numbers or generic #shorts as the first hashtag. Prioritize quality, not quantity.

DO NOT USE EMOJIS ANYWHERE.

TOPIC: ${topic}
SCRIPT: ${script}

Format:
TITLE: [title]
DESCRIPTION: [desc]
HASHTAGS: [hashtag1, hashtag2, ...]
`.trim();

    console.log('[DEBUG] Sending OpenAI prompt for viral metadata');
    const out = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: metaPrompt }],
      temperature: 0.8,
      max_tokens: 350,
    });

    const text = out.choices[0].message.content.trim();
    const titleMatch = text.match(/TITLE:\s*(.+)\s*DESCRIPTION:/i);
    const descMatch = text.match(/DESCRIPTION:\s*([\s\S]*?)HASHTAGS:/i);
    const hashtagsMatch = text.match(/HASHTAGS:\s*(.+)$/i);

    let viralTitle = stripEmojis(titleMatch ? titleMatch[1].trim() : oldTitle);
    let viralDesc = stripEmojis(descMatch ? descMatch[1].trim() : oldDesc);
    let viralTags = stripEmojis(hashtagsMatch ? hashtagsMatch[1].trim() : '');

    console.log('[DEBUG] Generated viral metadata:', { viralTitle, viralDesc, viralTags });
    return { viralTitle, viralDesc, viralTags };
  } catch (err) {
    console.error('[ERROR] Viral metadata generation failed:', err.message);
    return { viralTitle: oldTitle, viralDesc: oldDesc, viralTags: '' };
  }
}

// ==== SECTION 9: SCRIPT-TO-SCENES SPLITTER ====
console.log('[DEBUG] Entered SECTION 9: SCRIPT-TO-SCENES SPLITTER');
function splitScriptToScenes(script) {
  console.log('[DEBUG] Splitting script into scenes');
  return script
    .split(/(?<=[\.!\?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
}

// ==== SECTION 10: REMOVE GOOGLE CLOUD TTS CLIENT ====
console.log('[DEBUG] Entered SECTION 10: REMOVE GOOGLE CLOUD TTS CLIENT');

let pollyClient;
try {
  console.log('[DEBUG] Initializing Polly client');
  const polly = new AWS.Polly({ region: 'us-east-1' });
  pollyClient = polly;
  console.log('[DEBUG] Polly client initialized');
} catch (e) {
  console.error('[ERROR] Could not initialize Polly client:', e);
}

// ==== SECTION 11: POLLY TTS SYNTHESIZER ====
console.log('[DEBUG] Entered SECTION 11: POLLY TTS SYNTHESIZER');
async function synthesizeWithPolly(text, voice = 'Matthew', outPath) {
  console.log(`[DEBUG] Synthesizing speech with Polly for voice: ${voice}`);
  if (!pollyClient) throw new Error("Polly client not initialized.");
  const params = {
    Text: text,
    OutputFormat: 'mp3',
    VoiceId: voice,
    SampleRate: '22050',
  };

  try {
    const data = await pollyClient.synthesizeSpeech(params).promise();
    const mp3Path = outPath;
    console.log('[DEBUG] Speech synthesized successfully. Writing MP3...');
    await util.promisify(fs.writeFile)(mp3Path, data.AudioStream);

    const wavPath = mp3Path.replace('.mp3', '.wav');
    console.log('[DEBUG] Converting MP3 to WAV...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(mp3Path)
        .audioChannels(1)
        .audioFrequency(44100)
        .output(wavPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    console.log('[DEBUG] WAV file saved:', wavPath);
    return wavPath;
  } catch (err) {
    console.error('[ERROR] Polly TTS error:', err);
    throw new Error("Failed to synthesize speech using Polly.");
  }
}

// ==== SECTION 12: VOICES (REFRESHED LIST) ====
console.log('[DEBUG] Entered SECTION 12: VOICES (REFRESHED LIST)');
const elevenProVoices = [
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
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: false }
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

console.log('[DEBUG] Voices list loaded:', { elevenProVoices, pollyVoices });

// ==== SECTION 13: /api/voices ENDPOINT ====
console.log('[DEBUG] Entered SECTION 13: /api/voices ENDPOINT');
app.get('/api/voices', (req, res) => {
  console.log('[DEBUG] Fetching available voices');
  res.json({ success: true, voices: [...pollyVoices, ...elevenProVoices] });
});

// ==== SECTION 14: /api/generate-script ENDPOINT ====
console.log('[DEBUG] Entered SECTION 14: /api/generate-script ENDPOINT');
app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  if (!idea) return res.status(400).json({ success: false, error: 'Idea required' });

  console.log('[DEBUG] Generating script for idea:', idea);
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
    console.log('[DEBUG] Sending OpenAI prompt to generate script');
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

    console.log('[DEBUG] Generated script, title, description, and hashtags');
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
    console.error('[ERROR] Script generation failed:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: err.message });
  }
});

// ==== SECTION 15: /api/generate-video ENDPOINT ====
console.log('[DEBUG] Entered SECTION 15: /api/generate-video ENDPOINT');
app.post('/api/generate-video', (req, res) => {
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  console.log('[DEBUG] Job started:', jobId);
  res.json({ jobId });

  (async () => {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
        console.log('[DEBUG] Job failed due to timeout');
      }
    }, 10 * 60 * 1000);

    let workDir = null;
    let scenes = [];
    let steps = [];
    let totalSteps = 0;
    let currentStep = 0;
    let paidUser = false;
    let removeWatermark = false;
    let mainSubject = '';
    let voice = '';
    let script = '';

    try {
      ({ script, voice, removeWatermark, paidUser } = req.body);
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        console.log('[ERROR] Missing required data: script or voice');
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }

      console.log('[DEBUG] Starting video generation process');
      mainSubject = await extractMainSubject(script);
      if (!mainSubject) throw new Error('No main subject found for this script.');

      steps = splitScriptToScenes(script).slice(0, 8);
      totalSteps = steps.length + 4; // 4 extra: concat, watermark, upload, cleanup
      currentStep = 0;

      workDir = path.join(__dirname, 'tmp', uuidv4());
      fs.mkdirSync(workDir, { recursive: true });
      scenes = [];
      const usedUrls = new Set();

      let mediaFailCount = 0;
      for (let i = 0; i < steps.length; i++) {
        try {
          currentStep++;
          progress[jobId] = {
            percent: Math.round((currentStep / totalSteps) * 100),
            status: `Building scene ${i + 1}/${steps.length}`
          };

          const idx = String(i + 1).padStart(2, '0');
          const text = steps[i];
          const audioFile = path.join(workDir, `audio-${idx}.mp3`);
          const wavFile = path.join(workDir, `audio-${idx}.wav`);
          const clipBase = path.join(workDir, `media-${idx}`);
          const sceneFile = path.join(workDir, `scene-${idx}.mp4`);

          console.log('[DEBUG] Generating audio for scene:', idx);

          // --- AUDIO GENERATION ---
          const pollyVoiceIds = pollyVoices.map(v => v.id);
          if (pollyVoiceIds.includes(voice)) {
            const wav = await synthesizeWithPolly(text, voice, audioFile);
            fs.renameSync(wav, wavFile);
          } else {
            throw new Error(`Invalid voice selection: ${voice}`);
          }

          // --- GET AUDIO DURATION ---
          let audioDur = 3.5;
          try {
            audioDur = await new Promise((resolve, reject) =>
              ffmpeg.ffprobe(wavFile, (err, info) => err ? reject(err) : resolve(info.format.duration))
            );
          } catch (e) {
            audioDur = 3.5;
          }

          // --- FIND MATCHING CLIP ---
          const mediaObj = await pickClipFor(text, workDir, 0.13, mainSubject, Array.from(usedUrls));
          if (!mediaObj || !mediaObj.url) {
            mediaFailCount++;
            if (mediaFailCount > 3) {
              throw new Error(`Failed to get media for scene ${i + 1} after many attempts.`);
            }
            const fallbackClip = path.join(workDir, `fallback-${idx}.mp4`);
            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(`color=black:s=720x1280:d=${audioDur + 1.5}`)
                .inputFormat('lavfi')
                .output(fallbackClip)
                .on('end', resolve)
                .on('error', reject)
                .run();
            });

            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(fallbackClip)
                .input(wavFile)
                .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v libx264', '-c:a aac', '-shortest'])
                .save(sceneFile)
                .on('end', resolve)
                .on('error', reject);
            });

            scenes.push(sceneFile);
            continue;
          }

          usedUrls.add(mediaObj.originalUrl);

          // ---- FIX: Handle local file path vs URL for ext ----
          let ext;
          if (
            mediaObj.url.startsWith('http://') ||
            mediaObj.url.startsWith('https://')
          ) {
            ext = path.extname(new URL(mediaObj.url).pathname);
          } else {
            ext = path.extname(mediaObj.url);
          }
          const mediaPath = clipBase + ext;

          // ---- FIX: Handle download vs copy for URL or file ----
          if (
            mediaObj.url.startsWith('http://') ||
            mediaObj.url.startsWith('https://')
          ) {
            await downloadToFile(mediaObj.url, mediaPath);
          } else {
            fs.copyFileSync(mediaObj.url, mediaPath);
          }

          // --- ENCODE AUDIO TO M4A FOR FINAL SCENE ---
          const sceneAudio = path.join(workDir, `scene-audio-${idx}.m4a`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(wavFile)
              .outputOptions(['-c:a aac', '-b:a 128k'])
              .save(sceneAudio)
              .on('end', resolve)
              .on('error', reject);
          });

          const sceneLen = audioDur + 1.5;

          // --- STITCH AUDIO + VIDEO ---
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(mediaPath)
              .inputOptions(['-stream_loop', '-1'])
              .input(sceneAudio)
              .inputOptions([`-t ${sceneLen}`])
              .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v libx264', '-c:a aac', '-shortest', '-r 30'])
              .videoFilters('scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280')
              .save(sceneFile)
              .on('end', resolve)
              .on('error', reject);
          });

          scenes.push(sceneFile);

        } catch (err) {
          console.error("Scene", i + 1, "error:", err);
          progress[jobId] = { percent: 100, status: "Failed: " + err.message };
          cleanupJob(jobId, 10 * 1000);
          finished = true;
          clearTimeout(watchdog);
          return;
        }
      }

      // ==== SECTION 17: CONCATENATION, UPLOAD, & FINALIZING VIDEO ====
      currentStep++;
      progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Concatenating scenes..." };

      const listFile = path.join(workDir, 'list.txt');
      fs.writeFileSync(
        listFile,
        scenes.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
      );
      const concatFile = path.join(workDir, 'concat.mp4');

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
          .save(concatFile)
          .on('end', resolve)
          .on('error', reject);
      });

      const final = path.join(workDir, 'final.mp4');
      let useWatermark = !(paidUser && removeWatermark);

      if (useWatermark) {
        const watermarkPath = path.join(__dirname, 'frontend', 'logo.png');
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(concatFile)
            .input(watermarkPath)
            .complexFilter([
              '[1:v]scale=140:140:force_original_aspect_ratio=decrease[wm];' +
              '[0:v][wm]overlay=W-w-20:H-h-20'
            ])
            .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
            .save(final)
            .on('end', resolve)
            .on('error', reject);
        });
      } else {
        fs.copyFileSync(concatFile, final);
      }

      currentStep++;
      progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Uploading to cloud..." };
      const key = `videos/${uuidv4()}.mp4`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: fs.createReadStream(final),
        ContentType: 'video/mp4',
        ACL: 'public-read'
      }).promise();

      progress[jobId] = { percent: 100, status: "Done", key };
      cleanupJob(jobId, 90 * 1000);
      finished = true;
      clearTimeout(watchdog);

    } catch (err) {
      console.error('[ERROR] Fatal error in video generator:', err);
      progress[jobId] = { percent: 100, status: "Failed: " + err.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      return;
    }
  })();
});
console.log('[DEBUG] Video generation route set up successfully');


      // ==== SECTION 17: CONCATENATION, UPLOAD, & FINALIZING VIDEO ====
      currentStep++;
      progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Concatenating scenes..." };

      const listFile = path.join(workDir, 'list.txt');
      fs.writeFileSync(
        listFile,
        scenes.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
      );
      const concatFile = path.join(workDir, 'concat.mp4');

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f concat', '-safe 0'])
          .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
          .save(concatFile)
          .on('end', resolve)
          .on('error', reject);
      });

      const final = path.join(workDir, 'final.mp4');
      let useWatermark = !(paidUser && removeWatermark);

      if (useWatermark) {
        const watermarkPath = path.join(__dirname, 'frontend', 'logo.png');
        await new Promise((resolve, reject) => {
          ffmpeg()
            .input(concatFile)
            .input(watermarkPath)
            .complexFilter([
              '[1:v]scale=140:140:force_original_aspect_ratio=decrease[wm];' +
              '[0:v][wm]overlay=W-w-20:H-h-20'
            ])
            .outputOptions(['-c:v libx264', '-c:a aac', '-movflags +faststart'])
            .save(final)
            .on('end', resolve)
            .on('error', reject);
        });
      } else {
        fs.copyFileSync(concatFile, final);
      }

      currentStep++;
      progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Uploading to cloud..." };
      const key = `videos/${uuidv4()}.mp4`;
      await s3.upload({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: fs.createReadStream(final),
        ContentType: 'video/mp4',
        ACL: 'public-read'
      }).promise();

      progress[jobId] = { percent: 100, status: "Done", key };
      cleanupJob(jobId, 90 * 1000);
      finished = true;
      clearTimeout(watchdog);

    } catch (err) {
      console.error('[ERROR] Fatal error in video generator:', err);
      progress[jobId] = { percent: 100, status: "Failed: " + err.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      return;
    }
  })();
});
console.log('[DEBUG] Video generation route set up successfully');

// ==== SECTION 18: PROGRESS POLLING ENDPOINT ====
console.log('[DEBUG] Entered SECTION 18: PROGRESS POLLING ENDPOINT');
app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  console.log('[DEBUG] Progress request for jobId:', jobId);
  const job = progress[jobId];
  if (!job) {
    return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  }
  res.json(job);
});

// ==== SECTION 19: GENERATE VOICE PREVIEWS ENDPOINT ====
console.log('[DEBUG] Entered SECTION 19: GENERATE VOICE PREVIEWS ENDPOINT');
app.post('/api/generate-voice-previews', async (req, res) => {
  const sampleText = "This is a sample of my voice.";
  console.log('[DEBUG] Generating voice previews for all voices');
  try {
    // If you want to support Google/other voices, add the TTS logic here.
    res.json({ success: true, message: "Voice previews generated (placeholder)." });
  } catch (err) {
    console.error('[ERROR] Failed to generate voice previews:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==== SECTION 20: SPARKIE (IDEA GENERATOR) ENDPOINT ====
console.log('[DEBUG] Entered SECTION 20: SPARKIE (IDEA GENERATOR) ENDPOINT');
app.post('/api/sparkie', async (req, res) => {
  const { prompt } = req.body;
  console.log('[DEBUG] Generating creative ideas for prompt:', prompt);
  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt required' });

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
    console.log('[DEBUG] Sparkie idea generation completed');
    return res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch (e) {
    console.error('[ERROR] Sparkie idea generation failed:', e);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
});

// ==== SECTION 21: SERVE VIDEOS FROM CLOUDFLARE R2 (streaming, download, range support) ====
console.log('[DEBUG] Entered SECTION 21: SERVE VIDEOS FROM CLOUDFLARE R2');
app.get('/video/videos/:key', async (req, res) => {
  try {
    const key = `videos/${req.params.key}`;
    console.log('[DEBUG] Video request for key:', key);
    const headData = await s3.headObject({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }).promise();

    const total = headData.ContentLength;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

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
        console.error("R2 video stream error:", err);
        res.status(404).end('Video not found');
      });

      stream.pipe(res);
    } else {
      const stream = s3.getObject({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }).createReadStream();

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
      res.setHeader('Content-Length', total);

      stream.on('error', (err) => {
        console.error("R2 video stream error:", err);
        res.status(404).end('Video not found');
      });

      stream.pipe(res);
    }
  } catch (err) {
    console.error("[ERROR] Video route error:", err);
    res.status(500).end('Internal error');
  }
});

// ==== SECTION 22: 404 HTML FALLBACK FOR SPA (not API) ====
console.log('[DEBUG] Entered SECTION 22: 404 HTML FALLBACK FOR SPA');
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/video/')) {
    const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
    if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
      res.sendFile(htmlPath);
    } else {
      res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
    }
  } else {
    res.status(404).json({ error: 'Not found.' });
  }
});

// ==== SECTION 23: LAUNCH SERVER ====
console.log('[DEBUG] Entered SECTION 23: LAUNCH SERVER');
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
