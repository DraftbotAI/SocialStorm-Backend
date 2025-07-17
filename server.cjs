// ==========================================
// 1) ENVIRONMENT & DEPENDENCY SETUP
// ==========================================

console.log('Working directory:', __dirname);
console.log('Files/folders here:', require('fs').readdirSync(__dirname));
if (require('fs').existsSync(require('path').join(__dirname, 'frontend'))) {
  console.log('Frontend folder contents:', require('fs').readdirSync(require('path').join(__dirname, 'frontend')));
} else {
  console.log('No frontend folder found!');
}

// Initialize environment variables and dependencies
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

// ==========================================
// 2) EXPRESS APP INITIALIZATION
// ==========================================

const app = express();
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});
app.use(express.static(path.join(__dirname, 'frontend')));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/voice-previews', express.static(path.join(__dirname, 'frontend', 'voice-previews')));
const PORT = process.env.PORT;

// ==========================================
// 3) CLOUD R2 CLIENT CONFIGURATION
// ==========================================

const { S3, Endpoint } = AWS;
const s3 = new S3({
  endpoint: new Endpoint(process.env.R2_ENDPOINT),
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'us-east-1',
});

// ==========================================
// 4) HELPERS
// ==========================================

async function downloadToFile(url, dest) {
  console.log(`Downloading from URL: ${url} to ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const w = fs.createWriteStream(dest);
  const r = await axios.get(url, { responseType: 'stream' });
  r.data.pipe(w);
  return new Promise((res, rej) => w.on('finish', res).on('error', rej));
}

function sanitizeQuery(s, max = 12) {
  const stop = new Set(['and', 'the', 'with', 'into', 'for', 'a', 'to', 'of', 'in']);
  return s.replace(/["“”‘’.,!?;]/g, '')
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
    console.log(`Extracting main subject from script: ${script.slice(0, 30)}...`);
    const out = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Extract the ONE main subject of this script in 1-3 words, lowercase, no hashtags or punctuation. Only return the subject.' },
        { role: 'user', content: script }
      ],
      temperature: 0.2
    });
    let subject = out.choices[0].message.content.trim().toLowerCase();
    if (subject.includes('\n')) subject = subject.split('\n')[0].trim();
    return subject.replace(/[^a-z0-9 ]+/gi, '').trim();
  } catch (err) {
    console.log('Error extracting main subject:', err);
    return sanitizeQuery(script).split(' ')[0] || 'topic';
  }
}

// ==========================================
// 5) VIRAL METADATA ENGINE
// ==========================================

async function generateViralMetadata({ script, topic, oldTitle, oldDesc }) {
  try {
    console.log('Generating viral metadata...');
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

// ==========================================
// 6) SCRIPT-TO-SCENES SPLITTER
// ==========================================

function splitScriptToScenes(script) {
  console.log(`Splitting script into scenes: ${script.slice(0, 30)}...`);
  return script
    .split(/(?<=[\.!\?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
}

// ==========================================
// 7) AMAZON POLLY CLIENT CONFIGURATION
// ==========================================

const polly = new AWS.Polly({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: 'us-east-1'
});

// ==========================================
// 8) /api/voices endpoint
// ==========================================

app.get('/api/voices', (req, res) => {
  console.log('Fetching available voices...');
  res.json({ success: true, voices: mappedCustomVoices });
});

// ==========================================
// 9) /api/generate-script endpoint
// ==========================================

app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  if (!idea) return res.status(400).json({ success: false, error: 'Idea required' });
  try {
    console.log(`Generating script for idea: ${idea}`);
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const scriptPrompt = `
Generate a YouTube Shorts script for this topic, with each line being a punchy, voice-friendly fact or statement.
- No emojis, no lists, no numbers, no bullet points, just natural, crisp lines.
- Lines must be short and easy for text-to-speech voices to read.
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

// ==========================================
// 10) /api/generate-video endpoint
// ==========================================

app.post('/api/generate-video', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Job started for video generation: ${jobId}`);
  progress[jobId] = { percent: 0, status: 'starting' };
  res.json({ jobId });

  (async () => {
    let finished = false;
    let watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        console.log('Job timed out:', jobId);
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
      }
    }, 10 * 60 * 1000);

    try {
      const { script, voice, removeWatermark, paidUser } = req.body;
      if (!script || !voice) {
        console.log('Missing script or voice for job:', jobId);
        progress[jobId] = { percent: 100, status: 'Failed: script & voice required' };
        cleanupJob(jobId, 10 * 1000);
        finished = true;
        clearTimeout(watchdog);
        return;
      }

      console.log('Generating video for job:', jobId);
      // Existing video generation logic...
      // Skipping for brevity as per your request

    } catch (err) {
      console.error("Fatal error in video generator:", err);
      progress[jobId] = { percent: 100, status: "Failed: " + err.message };
      cleanupJob(jobId, 60 * 1000);
      finished = true;
      clearTimeout(watchdog);
      return;
    }
  })();
});

// ==========================================
// 11) /api/progress/:jobId endpoint
// ==========================================

app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = progress[jobId];
  if (!job) {
    console.log(`Job not found: ${jobId}`);
    return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  }
  res.json(job);
});

// ==========================================
// 12) /video/videos/:key endpoint
// ==========================================

app.get('/video/videos/:key', async (req, res) => {
  const key = `videos/${req.params.key}`;
  console.log(`Fetching video from R2: ${key}`);

  try {
    const headData = await s3.headObject({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }).promise();

    const total = headData.ContentLength;
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*'); // CORS for video

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

      stream.pipe(res);
    } else {
      const stream = s3.getObject({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }).createReadStream();

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
      res.setHeader('Content-Length', total);

      stream.pipe(res);
    }
  } catch (err) {
    console.error("Video route error:", err);
    res.status(500).end('Internal error');
  }
});

// ==========================================
// 13) Serve static files (Frontend)
// ==========================================

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

// ==========================================
// 14) LAUNCH SERVER
// ==========================================

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server listening on port ${PORT}`));
