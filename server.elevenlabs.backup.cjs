// ===== 1) ENVIRONMENT & DEPENDENCY SETUP =====
require('dotenv').config();
const express      = require('express');    // Web framework
const cors         = require('cors');       // Cross-origin support
const axios        = require('axios');      // HTTP requests
const fs           = require('fs');         // File system
const path         = require('path');       // File paths
const { v4: uuidv4 } = require('uuid');     // Unique IDs
const AWS          = require('aws-sdk');    // AWS SDK for S3/R2
const ffmpegPath   = require('ffmpeg-static');
const ffmpeg       = require('fluent-ffmpeg');
const { OpenAI }   = require('openai');     // OpenAI client
const { pickClipFor } = require('./pexels-helper'); // Pexels helper

// Point fluent-ffmpeg to static binary
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('Using ElevenLabs key:', process.env.ELEVENLABS_API_KEY?.slice(0,8), '…');

// ===== 2) EXPRESS APP INITIALIZATION =====
const app = express();
app.use(
  cors(),               // 2.1: Enable CORS
  express.json(),       // 2.2: Parse JSON bodies
  express.static(path.join(__dirname,'frontend')) // 2.3: Serve static frontend
);
const PORT = process.env.PORT || 3000;

// ===== 3) CLOUD R2 CLIENT CONFIGURATION =====
const { S3, Endpoint } = AWS;
const s3 = new S3({
  endpoint: new Endpoint(process.env.R2_ENDPOINT), // 3.1: R2 endpoint
  accessKeyId: process.env.R2_ACCESS_KEY,          // 3.2: Credentials
  secretAccessKey: process.env.R2_SECRET_KEY,
  signatureVersion: 'v4',
  region: 'us-east-1',
});

// ===== 4) HELPER FUNCTIONS =====
// 4.1: Download a stream URL to local file
async function downloadToFile(url, dest) {
  const w = fs.createWriteStream(dest);
  const r = await axios.get(url, { responseType:'stream' });
  r.data.pipe(w);
  return new Promise((res, rej) => w.on('finish', res).on('error', rej));
}
// 4.2: Clean up text for clip search
function sanitizeQuery(s, max=12) {
  const stop = new Set(['and','the','with','into','for','a','to','of','in']);
  return s.replace(/["]|[“”‘’.,!?]/g,'')
          .split(/\s+/)
          .filter(w=>!stop.has(w.toLowerCase()))
          .slice(0,max)
          .join(' ');
}

// ===== 5) ROUTES =====

// 5.1: Serve R2-hosted MP4 videos directly
app.get('/video/*', (req, res) => {
  res.setHeader('Content-Type','video/mp4');
  s3.getObject({ Bucket: process.env.R2_BUCKET, Key: req.params[0] })
    .createReadStream()
    .on('error', () => res.sendStatus(404))
    .pipe(res);
});

// 5.2: List available ElevenLabs voices
app.get('/api/voices', async (req, res) => {
  try {
    const out = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });
    const voices = out.data.voices.map(v => ({ id: v.voice_id, name: v.name }));
    res.json({ success: true, voices });
  } catch(err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5.3: Generate a 6-step script via OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  if (!idea) return res.status(400).json({ success: false, error: 'Idea required' });
  try {
    const c = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'Return exactly six numbered steps (1.–6.) with no extra text.' },
        { role: 'user', content: `Write a concise, step-by-step video script about: ${idea}` }
      ],
      temperature: 0.7
    });
    // Extract and ensure 6 lines
    const raw = c.choices[0].message.content;
    let lines = raw.split(/\r?\n/).map(l=>l.trim())
                   .filter(l=>/^[1-6]\.\s+/.test(l)).slice(0,6);
    while (lines.length < 6) lines.push(`${lines.length+1}. …`);
    res.json({ success: true, script: lines.join('\n') });
  } catch(err) {
    console.error('SCRIPT ERR:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5.4: Generate & stitch the video scenes
app.post('/api/generate-video', async (req, res) => {
  const { script, voice } = req.body;
  if (!script || !voice) return res.status(400).json({ success: false, error: 'script & voice required' });
  try {
    // 5.4.1: Parse script steps
    const steps = script.split('\n').map(l=>l.replace(/^[1-6]\.\s*/,'').trim()).slice(0,6);
    const workDir = path.join(__dirname, 'tmp', uuidv4());
    fs.mkdirSync(workDir, { recursive: true });
    const scenes = [];

    for (let i = 0; i < 6; i++) {
      const idx = String(i+1).padStart(2,'0');
      const text = steps[i];
      const audioFile  = path.join(workDir, `audio-${idx}.mp3`);
      const clipBase   = path.join(workDir, `media-${idx}`);
      const sceneFile  = path.join(workDir, `scene-${idx}.mp4`);

      console.log(`[${idx}] 1) TTS → ${text}`);
      // 5.4.2: ElevenLabs TTS
      const ttsResp = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
        { text, model_id: 'eleven_monolingual_v1' },
        { headers: {'xi-api-key': process.env.ELEVENLABS_API_KEY}, responseType: 'arraybuffer' }
      );
      fs.writeFileSync(audioFile, ttsResp.data);

      // 5.4.3: ffprobe to get audio duration
      const duration = await new Promise((r,e) => ffmpeg(audioFile).ffprobe((err, meta) => err ? e(err) : r(meta.format.duration)));
      console.log(`    duration: ${duration.toFixed(2)}s`);

      // 5.4.4: Pick and download a clip or photo
      const mediaUrl = await pickClipFor(sanitizeQuery(text));
      const ext = path.extname(new URL(mediaUrl).pathname).toLowerCase();
      await downloadToFile(mediaUrl, clipBase + ext);

      // 5.4.5: Render scene (video or looped image)
      if (ext === '.jpg' || ext === '.png') {
        console.log(`    looping image for ${duration.toFixed(1)}s`);
        await new Promise((r,e) => ffmpeg(clipBase + ext)
          .loop(duration).inputOptions('-framerate 30')
          .outputOptions('-c:v libx264', `-t ${duration}`, '-pix_fmt yuv420p','-movflags +faststart')
          .save(sceneFile).on('end', r).on('error', e)
        );
      } else {
        console.log(`    muxing clip for ${duration.toFixed(1)}s`);
        await new Promise((r,e) => ffmpeg()
          .input(clipBase + ext).setDuration(duration)
          .input(audioFile)
          .outputOptions('-c:v libx264','-c:a aac','-preset veryfast','-shortest','-movflags +faststart')
          .save(sceneFile).on('end', r).on('error', e)
        );
      }
      scenes.push(sceneFile);
    }

    // 5.4.6: Concatenate all scenes into final.mp4
    const listTxt = scenes.map(f => `file '${f}'`).join('\n');
    const listPath = path.join(workDir, 'list.txt');
    fs.writeFileSync(listPath, listTxt);
    const finalMp4 = path.join(workDir, 'final.mp4');
    console.log('    concatenating scenes');
    await new Promise((r,e) => ffmpeg()
      .input(listPath).inputOptions('-f concat','-safe 0')
      .outputOptions('-c:v libx264','-c:a aac','-preset veryfast','-movflags +faststart')
      .save(finalMp4).on('end', r).on('error', e)
    );

    // 5.4.7: Upload to Cloudflare R2
    const key = `videos/${uuidv4()}.mp4`;
    await s3.upload({ Bucket: process.env.R2_BUCKET, Key: key,
                      Body: fs.createReadStream(finalMp4),
                      ContentType: 'video/mp4', ACL: 'public-read' }).promise();
    res.json({ success: true, key });
  } catch(err) {
    console.error('VIDEO ERR:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===== 5.5) SPARKIE BOT =====
app.post('/api/sparkie', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: 'Prompt required' });
  try {
    const c = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are Sparkie…' },
        { role: 'user',   content: prompt       }
      ],
      temperature: 0.9
    });
    res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch(e) {
    console.error('SPARKIE ERR:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 6) LAUNCH SERVER =====
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
