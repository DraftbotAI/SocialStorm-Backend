const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');

// ==== DIRECTORY DEBUGGING (Safe to comment out in prod) ====
console.log('Working directory:', __dirname);
console.log('Files/folders here:', require('fs').readdirSync(__dirname));
if (require('fs').existsSync(require('path').join(__dirname, 'frontend'))) {
  console.log('Frontend folder contents:', require('fs').readdirSync(require('path').join(__dirname, 'frontend')));
} else {
  console.log('No frontend folder found!');
}

// ===== 1) ENVIRONMENT & DEPENDENCY SETUP =====
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
const { pickClipFor } = require('./pexels-helper.cjs');
const { OpenAI }     = require('openai');
const textToSpeech   = require('@google-cloud/text-to-speech');
const util           = require('util');

ffmpeg.setFfmpegPath(ffmpegPath);

// ====== PROGRESS TRACKING MAP ======
const progress = {};
const JOB_TTL_MS = 5 * 60 * 1000;
function cleanupJob(jobId, delay = JOB_TTL_MS) {
  setTimeout(() => { delete progress[jobId]; }, delay);
}

// ===== 2) EXPRESS APP INITIALIZATION =====
const app = express();
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(__dirname, 'frontend')));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/voice-previews', express.static(path.join(__dirname, 'frontend', 'voice-previews')));
const PORT = process.env.PORT || 3000;

// ===== HEALTH CHECK ENDPOINT =====
app.get('/health', (req, res) => res.status(200).send('OK'));

// ===== 3) CLOUD R2 CLIENT CONFIGURATION =====
const { S3, Endpoint } = AWS;
const s3 = new S3({
  endpoint: new Endpoint(process.env.R2_ENDPOINT),
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'us-east-1',
});

// ===== 4) HELPERS =====
async function downloadToFile(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const w = fs.createWriteStream(dest);
  const r = await axios.get(url, { responseType: 'stream' });
  r.data.pipe(w);
  return new Promise((res, rej) => w.on('finish', res).on('error', rej));
}
function sanitizeQuery(s, max=12) {
  const stop = new Set(['and','the','with','into','for','a','to','of','in']);
  return s.replace(/["“”‘’.,!?;]/g,'')
          .split(/\s+/)
          .filter(w => !stop.has(w.toLowerCase()))
          .slice(0, max)
          .join(' ');
}
function stripEmojis(str) {
  return str.replace(/\p{Extended_Pictographic}/gu, '');
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
    return subject.replace(/[^a-z0-9 ]+/gi, '').trim();
  } catch (err) {
    return sanitizeQuery(script).split(' ')[0] || 'topic';
  }
}

// ===== VIRAL METADATA ENGINE =====
async function generateViralMetadata({ script, topic, oldTitle, oldDesc }) {
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

    return { viralTitle, viralDesc, viralTags };
  } catch (err) {
    console.error("Viral metadata fallback, error:", err.message);
    return { viralTitle: oldTitle, viralDesc: oldDesc, viralTags: '' };
  }
}

// ====== SCRIPT-TO-SCENES SPLITTER ======
function splitScriptToScenes(script) {
  return script
    .split(/(?<=[\.!\?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
}

// === GOOGLE CLOUD TTS CLIENT ===
let googleTTSClient;
try {
  const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  googleTTSClient = new textToSpeech.TextToSpeechClient({
    credentials: creds
  });
} catch (e) {
  console.error('FATAL: Could not initialize Google TTS client from JSON:', e);
}

// ======= GOOGLE TTS SYNTHESIZER =======
async function synthesizeWithGoogleTTS(text, voice = 'en-US-Neural2-D', outPath) {
  if (!googleTTSClient) throw new Error("Google TTS not initialized (no credentials file)");
  const request = {
    input: { text },
    voice: { languageCode: 'en-US', name: voice },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: 1.0,
      pitch: 0.0,
      sampleRateHertz: 44100
    }
  };
  const [response] = await googleTTSClient.synthesizeSpeech(request);
  const mp3Path = outPath;
  await util.promisify(fs.writeFile)(mp3Path, response.audioContent, 'binary');
  const wavPath = mp3Path.replace('.mp3', '.wav');
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
  return wavPath;
}

function promiseTimeout(promise, ms, msg="Timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}
// ===== VOICES =====
function getVoicePreviewFile(id, fallback = null) {
  const previewDir = '/voice-previews/';
  const googlePattern = `sample_${id}.mp3`;
  if (fs.existsSync(path.join(__dirname, 'frontend', 'voice-previews', googlePattern))) {
    return `${previewDir}${googlePattern}`;
  }
  const basicPattern = `${id}.mp3`;
  if (fs.existsSync(path.join(__dirname, 'frontend', 'voice-previews', basicPattern))) {
    return `${previewDir}${basicPattern}`;
  }
  return fallback;
}

// ===== VOICES (REFRESHED LIST) =====
const googleFreeVoices = [
  { id: "en-US-Neural2-F", name: "Jenna (Free)",    description: "Google TTS, Female, US",     provider: "google",     tier: "Free", gender: "female", disabled: false },
  { id: "en-US-Neural2-G", name: "Hannah (Free)",   description: "Google TTS, Female, US",     provider: "google",     tier: "Free", gender: "female", disabled: false },
  { id: "en-US-Wavenet-F", name: "Sierra (Free)",   description: "Google TTS, Female, US",     provider: "google",     tier: "Free", gender: "female", disabled: false },
  { id: "en-US-Neural2-D", name: "Mason (Free)",    description: "Google TTS, Male, US",       provider: "google",     tier: "Free", gender: "male",   disabled: false },
  { id: "en-US-Neural2-J", name: "Daniel (Free)",   description: "Google TTS, Male, US",       provider: "google",     tier: "Free", gender: "male",   disabled: false },
  { id: "en-US-Wavenet-B", name: "Carter (Free)",   description: "Google TTS, Male, US",       provider: "google",     tier: "Free", gender: "male",   disabled: false }
];

const elevenProVoices = [
  { id: "ZthjuvLPty3kTMaNKVKb", name: "Mike (Pro)",   description: "ElevenLabs, Deep US Male",         provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "6F5Zhi321D3Oq7v1oNT4", name: "Jackson (Pro)",description: "ElevenLabs, Movie Style Narration",     provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "p2ueywPKFXYa6hdYfSIJ", name: "Tyler (Pro)", description: "ElevenLabs, US Male Friendly",     provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Olivia (Pro)",   description: "ElevenLabs, Warm US Female",     provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "FUfBrNit0NNZAwb58KWH", name: "Emily (Pro)",    description: "ElevenLabs, Conversational US Female", provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "xctasy8XvGp2cVO9HL9k", name: "Sophia (Pro Kid)", description: "ElevenLabs, US Female Young",  provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "goT3UYdM9bhm0n2lmKQx", name: "James (Pro UK)", description: "ElevenLabs, British Male",       provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "19STyYD15bswVz51nqLf", name: "Amelia (Pro UK)",description: "ElevenLabs, British Female",     provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "2h7ex7B1yGrkcLFI8zUO", name: "Pierre (Pro FR)",description: "ElevenLabs, French Male",        provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "xNtG3W2oqJs0cJZuTyBc", name: "Claire (Pro FR)",description: "ElevenLabs, French Female",      provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "IP2syKL31S2JthzSSfZH", name: "Diego (Pro ES)", description: "ElevenLabs, Spanish Accent Male",provider: "elevenlabs", tier: "Pro", gender: "male", disabled: true },
  { id: "WLjZnm4PkNmYtNCyiCq8", name: "Lucia (Pro ES)", description: "ElevenLabs, Spanish Accent Female",provider: "elevenlabs", tier: "Pro", gender: "female", disabled: true },
  { id: "zA6D7RyKdc2EClouEMkP", name: "Aimee (ASMR Pro)", description: "Female British Meditation ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true },
  { id: "RCQHZdatZm4oG3N6Nwme", name: "Dr. Lovelace (ASMR Pro)", description: "Pro Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true },
  { id: "RBknfnzK8KHNwv44gIrh", name: "James Whitmore (ASMR Pro)", description: "Gentle Whisper ASMR", provider: "elevenlabs", tier: "ASMR", gender: "male", disabled: true },
  { id: "GL7nH05mDrxcH1JPJK5T", name: "Aimee (ASMR Gentle)", description: "ASMR Gentle Whisper", provider: "elevenlabs", tier: "ASMR", gender: "female", disabled: true }
];

const mappedCustomVoices = [...googleFreeVoices, ...elevenProVoices].map(v => ({
  ...v,
  preview: getVoicePreviewFile(v.id, v.preview)
}));

// ===== /api/voices endpoint =====
app.get('/api/voices', (req, res) => {
  res.json({ success: true, voices: mappedCustomVoices });
});

// ===== SPARKIE (IMPROVED) ENDPOINT =====
app.post('/api/sparkie', async (req, res) => {
  const { category, prompt } = req.body;
  if (!category && !prompt) return res.status(400).json({ success: false, error: 'Prompt or category required' });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const sparkiePrompt = `
You are Sparkie, a YouTube Shorts script idea generator for an AI video tool.

Generate 7 of the most VIRAL, engaging, curiosity-driven short video ideas for the following topic and category, formatted for VOICE NARRATION. 
NO emojis, hashtags, or TikTok-style lists. 
Each idea is a detailed, voice-narratable sentence—a perfect first line for a viral YouTube Short.

CATEGORY: ${category || 'General'}
TOPIC: ${prompt || category}

EXAMPLES:
- "There's a hidden science behind why we dream every night."
- "Most people have never heard this ancient story that changed the world."
- "If you’ve ever wondered why some people never seem to age, here’s the truth."
- "Here’s the little-known secret behind the pyramids’ incredible design."
- "What happens when two of nature’s deadliest animals finally meet?"

Give only 7, no numbering or list format, just line by line.
`.trim();

    const c = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: sparkiePrompt }
      ],
      temperature: 0.94,
      max_tokens: 380
    });

    let ideas = c.choices[0].message.content
      .replace(/^[\d\-\.\*]+\s*/gm, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 8);

    return res.json({ success: true, ideas });
  } catch (e) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
});

// ===== /api/generate-script endpoint (IMPROVED FOR VOICE NARRATION) =====
app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  if (!idea) return res.status(400).json({ success: false, error: 'Idea required' });
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const scriptPrompt = `
Generate a YouTube Shorts script for this topic, with each line being a powerful, voice-friendly hook, fact, or micro-story. 
The FIRST line must be a highly engaging, curiosity-driven intro statement designed to make someone stop scrolling. 
NO emojis, NO hashtags, NO numbered lists, NO TikTok text, NO bullet points—just crisp, natural narration. 
Each line must be a standalone, interesting, or surprising statement relevant to the theme. 
All lines should be short, direct, and easy for a text-to-speech voice to read out loud. 
Never repeat the same words or phrases.

THEME: ${idea}

SCRIPT:
`.trim();

    const out = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: scriptPrompt }],
      temperature: 0.94,
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
    console.error('SCRIPT ERR:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: err.message });
  }
});
// ===== /api/generate-video endpoint =====
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
      const { script, voice, removeWatermark, paidUser } = req.body;
      if (!script || !voice) {
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }

      const mainSubject = await extractMainSubject(script);
      if (!mainSubject) throw new Error('No main subject found for this script.');

      const steps = splitScriptToScenes(script).slice(0, 8);
      const totalSteps = steps.length + 4;
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

          const googleVoiceIds = googleFreeVoices.map(v => v.id);
          if (googleVoiceIds.includes(voice)) {
            const wav = await synthesizeWithGoogleTTS(text, voice, audioFile);
            fs.renameSync(wav, wavFile);
          } else {
            try {
              const ttsRes = await axios.post(
                `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
                { text, model_id: 'eleven_monolingual_v1' },
                { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
              );
              fs.writeFileSync(audioFile, ttsRes.data);
              await new Promise((resolve, reject) => {
                ffmpeg()
                  .input(audioFile)
                  .audioChannels(1)
                  .audioFrequency(44100)
                  .output(wavFile)
                  .on('end', resolve)
                  .on('error', reject)
                  .run();
              });
            } catch (err) {
              console.error("TTS/Eleven error for scene", i+1, err);
              progress[jobId] = { percent: 100, status: `Failed: ElevenLabs error for voice "${voice}": ${err.message}` };
              cleanupJob(jobId, 10 * 1000);
              finished = true;
              clearTimeout(watchdog);
              return;
            }
          }

          let audioDur = 3.5;
          try {
            audioDur = await new Promise((resolve, reject) =>
              ffmpeg.ffprobe(wavFile, (err, info) => err ? reject(err) : resolve(info.format.duration))
            );
          } catch (e) {
            audioDur = 3.5;
          }

          let mediaObj = null;
          let attempts = 0;
          let found = false;

          while (attempts < 4 && !found) {
            try {
              mediaObj = await promiseTimeout(
                pickClipFor(mainSubject, text, undefined, mainSubject, Array.from(usedUrls)),
                20000,
                "pickClipFor timed out"
              );
            } catch (err) {
              mediaObj = null;
            }
            if (!mediaObj || !mediaObj.url) {
              attempts++;
              continue;
            }
            if (usedUrls.has(mediaObj.url) || (mediaObj.id && usedIds.has(mediaObj.id))) {
              attempts++;
              continue;
            }
            usedUrls.add(mediaObj.url);
            if (mediaObj.id) usedIds.add(mediaObj.id);
            found = true;
          }

          if ((!mediaObj || !mediaObj.url) && fallbackQueries.length > 0) {
            for (const q of fallbackQueries) {
              try {
                mediaObj = await promiseTimeout(
                  pickClipFor(q, text, undefined, q, Array.from(usedUrls)),
                  15000,
                  "pickClipFor fallback timed out"
                );
              } catch (err) {
                mediaObj = null;
              }
              if (mediaObj && mediaObj.url && !usedUrls.has(mediaObj.url)) {
                usedUrls.add(mediaObj.url);
                if (mediaObj.id) usedIds.add(mediaObj.id);
                found = true;
                break;
              }
            }
          }

          if (!mediaObj || !mediaObj.url) {
            mediaFailCount++;
            if (mediaFailCount > 3) {
              throw new Error(`Failed to get media for scene ${i+1} after many attempts.`);
            }
            const colorClip = path.join(workDir, `fallback-black-${idx}.mp4`);
            let safeDuration = Number(audioDur) && !isNaN(audioDur) ? audioDur + 1.5 : 3.5;
            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(`color=black:s=720x1280:d=${safeDuration}`)
                .inputFormat('lavfi')
                .output(colorClip)
                .on('end', resolve)
                .on('error', reject)
                .run();
            });

            await new Promise((resolve, reject) => {
              ffmpeg()
                .input(colorClip)
                .input(wavFile)
                .outputOptions([
                  '-map 0:v:0',
                  '-map 1:a:0',
                  '-c:v libx264',
                  '-c:a aac',
                  '-shortest',
                  '-r 30'
                ])
                .save(sceneFile)
                .on('end', resolve)
                .on('error', reject);
            });

            scenes.push(sceneFile);
            continue;
          }

          const ext = path.extname(new URL(mediaObj.url).pathname);
          await downloadToFile(mediaObj.url, clipBase + ext);

          const leadFile = path.join(workDir, `lead-${idx}.wav`);
          const tailFile = path.join(workDir, `tail-${idx}.wav`);

          await new Promise((resolve, reject) => {
            ffmpeg()
              .input('anullsrc=r=44100:cl=mono')
              .inputFormat('lavfi')
              .outputOptions(['-t 0.5'])
              .save(leadFile)
              .on('end', resolve)
              .on('error', reject);
          });

          await new Promise((resolve, reject) => {
            ffmpeg()
              .input('anullsrc=r=44100:cl=mono')
              .inputFormat('lavfi')
              .outputOptions(['-t 1.0'])
              .save(tailFile)
              .on('end', resolve)
              .on('error', reject);
          });

          const sceneAudioWav = path.join(workDir, `scene-audio-${idx}.wav`);
          const audListFile = path.join(workDir, `audlist-${idx}.txt`);
          fs.writeFileSync(
            audListFile,
            [leadFile, wavFile, tailFile].map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
          );

          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(audListFile)
              .inputOptions(['-f concat', '-safe 0'])
              .outputOptions(['-c:a pcm_s16le'])
              .save(sceneAudioWav)
              .on('end', resolve)
              .on('error', reject);
          });

          const sceneAudio = path.join(workDir, `scene-audio-${idx}.m4a`);
          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(sceneAudioWav)
              .outputOptions(['-c:a aac', '-b:a 128k'])
              .save(sceneAudio)
              .on('end', resolve)
              .on('error', reject);
          });

          const sceneLen = audioDur + 1.5;

          await new Promise((resolve, reject) => {
            ffmpeg()
              .input(clipBase + ext)
              // Removed stream_loop -1 to prevent looping of video clips
              .input(sceneAudio)
              .inputOptions([`-t ${sceneLen}`])
              .outputOptions([
                '-map 0:v:0',
                '-map 1:a:0',
                '-c:v libx264',
                '-c:a aac',
                '-shortest',
                '-r 30'
              ])
              .videoFilters(
                'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280'
              )
              .save(sceneFile)
              .on('end', resolve)
              .on('error', reject);
          });

          scenes.push(sceneFile);

        } catch (err) {
          console.error("Scene", i+1, "error:", err);
          progress[jobId] = { percent: 100, status: "Failed: " + err.message };
          cleanupJob(jobId, 10 * 1000);
          finished = true;
          clearTimeout(watchdog);
          return;
        }
      }

      // Outro, watermark, concat, upload, etc
      if (!(paidUser && removeWatermark)) {
        try {
          currentStep++;
          progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Adding outro..." };
          const outroText = "This video was made with SocialStormAI.";
          const outroLogo = path.join(__dirname, 'frontend', 'logo.png');
          const outroVoiceId = voice;
          const outroWorkDir = workDir;
          const thunderSfx = path.join(__dirname, 'frontend', 'assets', 'thunder.mp3');
          if (fs.existsSync(outroLogo) && fs.existsSync(thunderSfx)) {
            const outroAudioMp3 = path.join(outroWorkDir, 'outro-audio.mp3');
            const outroAudioWav = path.join(outroWorkDir, 'outro-audio.wav');
            const outroThunderWav = path.join(outroWorkDir, 'thunder.wav');
            const outroAudioMixed = path.join(outroWorkDir, 'outro-mixed.wav');
            const outroSceneFile = path.join(outroWorkDir, 'scene-outro.mp4');

            const googleVoiceIds = googleFreeVoices.map(v => v.id);
            if (googleVoiceIds.includes(outroVoiceId)) {
              const wav = await synthesizeWithGoogleTTS(outroText, outroVoiceId, outroAudioMp3);
              fs.renameSync(wav, outroAudioWav);
            } else {
              try {
                const ttsOutroRes = await axios.post(
                  `https://api.elevenlabs.io/v1/text-to-speech/${outroVoiceId}`,
                  { text: outroText, model_id: 'eleven_monolingual_v1' },
                  { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, responseType: 'arraybuffer' }
                );
                fs.writeFileSync(outroAudioMp3, ttsOutroRes.data);
                await new Promise((resolve, reject) => {
                  ffmpeg()
                    .input(outroAudioMp3)
                    .audioChannels(1)
                    .audioFrequency(44100)
                    .output(outroAudioWav)
                    .on('end', resolve)
                    .on('error', reject)
                    .run();
                });
              } catch (err) {
                progress[jobId] = { percent: 100, status: `Failed: ElevenLabs outro error: ${err.message}` };
                cleanupJob(jobId, 10 * 1000);
                finished = true;
                clearTimeout(watchdog);
                return;
              }
            }

            await new Promise((resolve, reject) =>
              ffmpeg()
                .input(thunderSfx)
                .outputOptions(['-t 2.2'])
                .output(outroThunderWav)
                .on('end', resolve)
                .on('error', reject)
                .run()
            );

            await new Promise((resolve, reject) =>
              ffmpeg()
                .input(outroAudioWav)
                .input(outroThunderWav)
                .complexFilter([
                  '[0:a]volume=1.2[a0];[1:a]volume=0.5[a1];[a0][a1]amix=inputs=2:duration=first'
                ])
                .output(outroAudioMixed)
                .on('end', resolve)
                .on('error', reject)
                .run()
            );

            const outroDur = await new Promise((resolve, reject) => {
              ffmpeg.ffprobe(outroAudioMixed, (err, info) => {
                if (err || !info?.format?.duration) return resolve(4.5);
                resolve(info.format.duration + 0.2);
              });
            });

            const ff = ffmpeg()
              .input(`color=black:s=720x1280:d=${outroDur}`)
              .inputFormat('lavfi')
              .input(outroLogo).inputOptions(['-loop', '1'])
              .complexFilter([
                "[1:v]scale=650:650:force_original_aspect_ratio=decrease[brand];" +
                "[0:v][brand]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2"
              ])
              .input(outroAudioMixed)
              .outputOptions([
                '-shortest',
                '-c:v libx264',
                '-c:a aac',
                '-pix_fmt yuv420p',
                '-r 30'
              ])
              .save(outroSceneFile);

            await new Promise(resolve => ff.on('end', resolve));
            scenes.push(outroSceneFile);
            progress[jobId] = { percent: Math.round((currentStep / totalSteps) * 100), status: "Outro added." };
          }
        } catch (err) {
          console.error("Outro creation failed:", err);
        }
      }

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

    } catch (e) {
      console.error("Fatal error in video generator:", e);
      progress[jobId] = { percent: 100, status: "Failed: " + e.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      return;
    }
  })();
});
// ===== PROGRESS POLLING ENDPOINT =====
app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = progress[jobId];
  if (!job) {
    return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  }
  res.json(job);
});

// ===== GENERATE VOICE PREVIEWS ENDPOINT =====
app.post('/api/generate-voice-previews', async (req, res) => {
  const sampleText = "This is a sample of my voice.";
  try {
    for (const v of googleFreeVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `sample_${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithGoogleTTS(sampleText, v.id, filePath);
        console.log("Generated preview for", v.name);
      }
    }
    res.json({ success: true, message: "Google voice previews generated." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======= /api/generate-thumbnails =======
app.post('/api/generate-thumbnails', async (req, res) => {
  try {
    const { topic, caption } = req.body;
    if (!topic || topic.length < 2) {
      return res.status(400).json({ success: false, error: "Topic required." });
    }

    // Load fonts for thumbnail text rendering
    try {
      registerFont(path.join(__dirname, 'fonts', 'BebasNeue-Regular.ttf'), { family: 'Bebas Neue' });
      registerFont(path.join(__dirname, 'fonts', 'Anton-Regular.ttf'), { family: 'Anton' });
      registerFont(path.join(__dirname, 'fonts', 'Oswald-Regular.ttf'), { family: 'Oswald' });
      registerFont(path.join(__dirname, 'fonts', 'Impact.ttf'), { family: 'Impact' });
    } catch (err) {
      console.error("Font load error:", err);
    }

    const canvasWidth = 1280;
    const canvasHeight = 720;
    const previews = [];
    const zip = new JSZip();

    // Use provided caption or fallback viral caption array
    const captions = caption ? [caption] : [
      "You Won't Believe This!",
      "Top Secrets Revealed",
      "Watch Before It's Gone",
      "How To Change Your Life",
      "Shocking Truths Uncovered",
      "Must See Facts",
      "The Ultimate Guide",
      "Hidden Details Exposed",
      "Unlock The Mystery",
      "This Changed Everything"
    ];

    for (let i = 0; i < captions.length; i++) {
      const text = captions[i];
      const canvas = createCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');

      // Background color or transparent if you want
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // Text styling: bold yellow with black outline
      ctx.font = 'bold 100px "Impact", "Anton", "Bebas Neue", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffd700'; // gold/yellow
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'black';

      // Outline then fill text
      ctx.strokeText(text, canvasWidth / 2, canvasHeight / 2);
      ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

      const buffer = canvas.toBuffer('image/png');
      const fileName = `thumbnail-${i + 1}.png`;
      zip.file(fileName, buffer);

      previews.push({
        fileName,
        dataUrl: 'data:image/png;base64,' + buffer.toString('base64')
      });
    }

    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });

    res.json({
      success: true,
      previews,
      zip: "data:application/zip;base64," + zipBuf.toString('base64')
    });
  } catch (err) {
    console.error("Thumbnail generation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== Serve videos from Cloudflare R2 (streaming, download, range support) =====
app.get('/video/videos/:key', async (req, res) => {
  try {
    const key = `videos/${req.params.key}`;
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
    console.error("Video route error:", err);
    res.status(500).end('Internal error');
  }
});

// Handle pretty URLs for .html pages (e.g., /pricing → /pricing.html)
app.get('/:page', (req, res, next) => {
  const page = req.params.page;
  if (page.startsWith('api') || page === 'video') {
    return next();
  }
  const htmlPath = path.join(__dirname, 'frontend', `${page}.html`);
  if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
    return res.sendFile(htmlPath);
  }
  next();
});

// ===== 404 HTML fallback for SPA (not API) =====
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

// ===== LAUNCH SERVER =====
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${PORT}`));
