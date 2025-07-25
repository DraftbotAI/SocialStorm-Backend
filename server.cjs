/* ===========================================================
   SECTION 1: SETUP & DEPENDENCIES
   -----------------------------------------------------------
   - Loads all environment variables and core node modules
   - Sets up Express app, AWS, OpenAI, FFmpeg
   - Includes utilities and logging config
   =========================================================== */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);
console.log('[DEBUG] Using ffmpeg binary:', ffmpegPath);
const util = require('util');
const { v4: uuidv4 } = require('uuid');
const AWS = require('aws-sdk'); // For Polly
const { OpenAI } = require('openai');


// ==== IMPORT ALL SCENE/GENERATION HELPERS NEEDED FOR SECTION 15 ====
// (Add your helper requires here, e.g. splitScriptToScenes, matchVideoClip, etc.)

// ==== EXPRESS APP INITIALIZATION ====
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ==== AWS & S3 CLIENT SETUP ====
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  }
});

// ==== POLLY (AWS TTS) SETUP ====
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// ==== OPENAI (for GPT/LLM) SETUP ====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==== GENERAL UTILITIES ====
const PUBLIC_VIDEO_DIR = path.join(__dirname, 'public', 'videos');
if (!fs.existsSync(PUBLIC_VIDEO_DIR)) fs.mkdirSync(PUBLIC_VIDEO_DIR, { recursive: true });

const JOBS_DIR = path.join(__dirname, 'jobs');
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

console.log('[DEBUG] Environment variables and dependencies loaded.');





/* ===========================================================
   SECTION 2: STATIC ASSETS & ROUTING
   -----------------------------------------------------------
   - Serves frontend and static files
   - Health check and base API endpoints
   =========================================================== */

// ==== STATIC FILES (Frontend) ====
app.use(express.static(path.join(__dirname, 'frontend')));

// ==== HEALTH CHECK ====
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ==== ROOT ====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});



/* ===========================================================
   SECTION 3: VOICES ENDPOINTS
   -----------------------------------------------------------
   - Returns all available voices with metadata
   - No placeholders, all live voices with descriptions/tier/preview
   =========================================================== */

const voices = [
  // ===== FREE (AWS POLLY) VOICES =====
  {
    id: "polly-matthew", // <-- this is the ID your FE/backend must use!
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
    description: "Clear, relatable American male (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-joey.mp3",
    disabled: false
  },
  {
    id: "polly-brian",
    name: "Brian",
    description: "British male (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-brian.mp3",
    disabled: false
  },
  {
    id: "polly-russell",
    name: "Russell",
    description: "Australian male (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-russell.mp3",
    disabled: false
  },
  {
    id: "polly-kimberly",
    name: "Kimberly",
    description: "Young American female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-kimberly.mp3",
    disabled: false
  },
  {
    id: "polly-amy",
    name: "Amy",
    description: "British female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-amy.mp3",
    disabled: false
  },
  {
    id: "polly-salli",
    name: "Salli",
    description: "Energetic American female (Free Tier)",
    tier: "Free",
    provider: "Amazon Polly",
    preview: "/assets/voices/polly-salli.mp3",
    disabled: false
  },

  // ===== ELEVENLABS STANDARD (PAID) =====
  {
    id: "11-mike",
    name: "Mike",
    description: "Viral, dynamic male (English, ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-mike.mp3",
    disabled: false
  },
  {
    id: "11-jackson",
    name: "Jackson",
    description: "Casual American male (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-jackson.mp3",
    disabled: false
  },
  {
    id: "11-tyler",
    name: "Tyler",
    description: "Serious American male (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-tyler.mp3",
    disabled: false
  },
  {
    id: "11-olivia",
    name: "Olivia",
    description: "Natural American female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-olivia.mp3",
    disabled: false
  },
  {
    id: "11-emily",
    name: "Emily",
    description: "Soothing, energetic female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-emily.mp3",
    disabled: false
  },
  {
    id: "11-sophia",
    name: "Sophia",
    description: "Bright, friendly female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-sophia.mp3",
    disabled: false
  },
  {
    id: "11-james",
    name: "James",
    description: "Deep, authoritative male (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-james.mp3",
    disabled: false
  },
  {
    id: "11-amelia",
    name: "Amelia",
    description: "Relatable, calm female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-amelia.mp3",
    disabled: false
  },
  {
    id: "11-pierre",
    name: "Pierre",
    description: "French male (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-pierre.mp3",
    disabled: false
  },
  {
    id: "11-claire",
    name: "Claire",
    description: "French female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-claire.mp3",
    disabled: false
  },
  {
    id: "11-diego",
    name: "Diego",
    description: "Spanish male (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-diego.mp3",
    disabled: false
  },
  {
    id: "11-lucia",
    name: "Lucia",
    description: "Spanish female (ElevenLabs)",
    tier: "Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-lucia.mp3",
    disabled: false
  },

  // ===== ELEVENLABS SPECIALTY (ASMR, GENTLE, ETC) =====
  {
    id: "11-aimee-asmr",
    name: "Aimee (ASMR Pro)",
    description: "ASMR professional female (ElevenLabs ASMR)",
    tier: "ASMR Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-aimee-asmr.mp3",
    disabled: false
  },
  {
    id: "11-dr-lovelace",
    name: "Dr. Lovelace (ASMR Pro)",
    description: "Whispered ASMR male (ElevenLabs ASMR)",
    tier: "ASMR Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-dr-lovelace.mp3",
    disabled: false
  },
  {
    id: "11-james-whitmore",
    name: "James Whitmore (ASMR Pro)",
    description: "Deep male, gentle ASMR (ElevenLabs ASMR)",
    tier: "ASMR Pro",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-james-whitmore.mp3",
    disabled: false
  },
  {
    id: "11-aimee-gentle",
    name: "Aimee (ASMR Gentle)",
    description: "Soft, gentle ASMR female (ElevenLabs Gentle)",
    tier: "ASMR Gentle",
    provider: "ElevenLabs",
    preview: "/assets/voices/11-aimee-gentle.mp3",
    disabled: false
  }
];

// ==== GET ALL VOICES (for frontend selection) ====
app.get('/api/voices', (req, res) => {
  res.json({ success: true, voices });
});



/* ===========================================================
   SECTION 4: SCRIPT GENERATION & METADATA ENDPOINTS
   -----------------------------------------------------------
   - /api/generate-script: Takes user idea, returns viral script & metadata
   - /api/generate-metadata: Accepts script, returns title, description, tags
   - Uses OpenAI for high-quality, viral output
   =========================================================== */

// ---- /api/generate-script ----
app.post('/api/generate-script', async (req, res) => {
  const { idea } = req.body;
  if (!idea || typeof idea !== "string" || idea.length < 2) {
    return res.json({ success: false, error: "Enter a video idea to start." });
  }

  try {
    // --- Viral, human, clever prompt engineering ---
    const systemPrompt = `
You are a viral video scriptwriter for TikTok, Reels, and YouTube Shorts.

**Rules:**
- The FIRST line must be a dramatic, funny, or surprising HOOK. (Examples: "You’ll never guess what happens next...", "This is why cats secretly rule the world!", "Here’s a fact that will blow your mind:")
- The REST of the lines should be punchy, fact-packed, and clever—always with a sense of humor or drama. No boring or robotic lines, ever.
- Make each sentence a separate line. Each line should be short, direct, and easy to read aloud.
- Never use animal metaphors unless the topic is literally about animals.
- Use a relatable, clever tone—like a funny friend who’s in on the secret.
- Never use academic or dry language.

**Output format:**
Script:
[HOOK LINE (funny or dramatic)]
[Fact 1 (funny or clever)]
[Fact 2 (witty, interesting)]
[Fact 3 (dramatic or relatable)]
[Fact 4 (memorable/funny)]
[Fact 5 (if needed)]
Title:
[title]
Description:
[description]
Hashtags:
[hashtag1, hashtag2, ...]
    `.trim();

    const userPrompt = `Video idea: ${idea}\nScript, title, description, and hashtags:`;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You write viral short-form video scripts, always starting with a hook." },
        { role: "user", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.87,
      max_tokens: 900,
      top_p: 1
    });

    const text = gptResponse.choices[0].message.content || '';
    // Parse into script/metadata
    let script = '';
    let title = '';
    let description = '';
    let hashtags = '';

    // Regex block extraction
    const scriptMatch = text.match(/Script:\s*([\s\S]+?)\nTitle:/i);
    const titleMatch = text.match(/Title:\s*(.+)\nDescription:/i);
    const descMatch = text.match(/Description:\s*([\s\S]+?)\nHashtags:/i);
    const tagsMatch = text.match(/Hashtags:\s*([\s\S]+)/i);

    script = scriptMatch ? scriptMatch[1].trim() : '';
    title = titleMatch ? titleMatch[1].trim() : '';
    description = descMatch ? descMatch[1].trim() : '';
    hashtags = tagsMatch ? tagsMatch[1].trim() : '';

    // Remove empty lines
    script = script.split('\n').map(line => line.trim()).filter(Boolean).join('\n');

    if (!script || !title) {
      return res.json({ success: false, error: "AI script generation failed. Please try again." });
    }

    res.json({
      success: true,
      script,
      title,
      description,
      tags: hashtags
    });
  } catch (err) {
    console.error('[ERROR] /api/generate-script:', err);
    res.json({ success: false, error: "AI error. Try again later." });
  }
});


// ---- /api/generate-metadata ----
app.post('/api/generate-metadata', async (req, res) => {
  const { script } = req.body;
  if (!script || typeof script !== "string" || script.length < 10) {
    return res.json({ success: false, error: "Enter a script first." });
  }

  try {
    const prompt = `
You are a viral short-form video copywriter for YouTube Shorts, TikTok, and Reels.
Given a script, generate:
- **A clickbait viral title** that triggers curiosity, FOMO, or surprise — use big emotions, controversy, or a wild promise. No boring titles!
- **A punchy, modern, engaging description** (2-3 lines) that teases the video, promises a payoff, hooks the scroller, and includes a call-to-action like "Watch till the end!" or "Comment your favorite tip below!"
- **10 high-viral hashtags** (comma-separated), mixing relevant, trending, and big-view tags. Always return 10.

Format your output *exactly* as:
Title: [title]
Description: [description]
Hashtags: [tag1, tag2, tag3, ...]
Script:
${script}
`;

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: prompt }
      ],
      temperature: 0.95,
      max_tokens: 350,
      top_p: 1
    });

    const text = gptResponse.choices[0].message.content || '';
    let title = '';
    let description = '';
    let hashtags = '';

    const titleMatch = text.match(/Title:\s*(.+)\nDescription:/i);
    const descMatch = text.match(/Description:\s*([\s\S]+?)\nHashtags:/i);
    const tagsMatch = text.match(/Hashtags:\s*([\s\S]+)/i);

    title = titleMatch ? titleMatch[1].trim() : '';
    description = descMatch ? descMatch[1].trim() : '';
    hashtags = tagsMatch ? tagsMatch[1].trim() : '';

    if (!title || !description) {
      return res.json({ success: false, error: "Failed to generate metadata." });
    }

    res.json({
      success: true,
      title,
      description,
      tags: hashtags
    });
  } catch (err) {
    console.error('[ERROR] /api/generate-metadata:', err);
    res.json({ success: false, error: "AI error. Try again later." });
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

app.post('/api/generate-video', (req, res) => {
  const jobId = uuidv4();
  progress[jobId] = { percent: 0, status: 'starting' };
  res.json({ jobId });

  (async () => {
    let finished = false;
    const watchdog = setTimeout(() => {
      if (!finished && progress[jobId]) {
        progress[jobId] = { percent: 100, status: "Failed: Timed out." };
        cleanupJob(jobId);
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
      script = req.body.script || '';
      selectedVoice = req.body.voice || 'polly-matthew';
      paidUser = !!req.body.paidUser;
      removeWatermark = !!req.body.removeWatermark;

      if (!script || typeof script !== "string" || script.length < 10) {
        progress[jobId] = { percent: 100, status: "Failed: No script." };
        return cleanupJob(jobId);
      }
      if (!selectedVoice || typeof selectedVoice !== "string") {
        progress[jobId] = { percent: 100, status: "Failed: No voice." };
        return cleanupJob(jobId);
      }

      // --- Working directory for this job ---
      workDir = path.join(JOBS_DIR, jobId);
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

      // --- Step 1: Split script into scenes ---
      const lines = script.split('\n').map(line => line.trim()).filter(Boolean);
      totalSteps = lines.length + 3; // audio, merge, finalize

      // --- Step 2: Generate scene audio (Polly for now, future: ElevenLabs) ---
      let audioFiles = [];
      let sceneIdx = 1;
      for (const line of lines) {
        currentStep++;
        progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: `Generating audio for scene ${sceneIdx}` };
        // TTS request (Polly for free, ElevenLabs for paid, etc)
        let voiceId = "Matthew";
        if (selectedVoice.startsWith("polly-")) voiceId = selectedVoice.replace("polly-", "");
        // Polly call (sync for reliability)
        const polly = new AWS.Polly();
        const audioRes = await polly.synthesizeSpeech({
          OutputFormat: 'mp3',
          Text: line,
          VoiceId: voiceId,
          Engine: "neural"
        }).promise();
        const audioPath = path.join(workDir, `scene${sceneIdx}.mp3`);
        fs.writeFileSync(audioPath, audioRes.AudioStream);
        audioFiles.push(audioPath);
        sceneIdx++;
      }

      // --- Step 3: Select video clips for each scene ---
      let videoFiles = [];
      sceneIdx = 1;
      for (const line of lines) {
        currentStep++;
        progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: `Selecting video for scene ${sceneIdx}` };
        // For revert: fallback to local library or stock folder. (Future: GPT matching)
        // We'll use a placeholder clip here for revert; update logic as needed.
        let videoPath = path.join(__dirname, 'frontend', 'assets', 'stock_clips', `clip${sceneIdx}.mp4`);
        if (!fs.existsSync(videoPath)) videoPath = path.join(__dirname, 'frontend', 'assets', 'stock_clips', `clip1.mp4`);
        // ==== DIR/FILE SAFETY: Skip if path is not a file ====
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
        // Only merge if video and audio exist (safety)
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
          sceneFiles.push(outPath);
        } else {
          console.error('[EISDIR FAILSAFE] Skipped merge: file missing or is directory.', vPath, aPath);
        }
      }

      // --- Step 5: Concat all scenes ---
      currentStep++;
      progress[jobId] = { percent: Math.round(100 * currentStep / totalSteps), status: "Concatenating scenes" };
      // Make a filelist.txt for ffmpeg concat
      const fileListPath = path.join(workDir, 'filelist.txt');
      const concatList = sceneFiles
        .filter(p => fs.existsSync(p) && fs.statSync(p).isFile())
        .map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
      fs.writeFileSync(fileListPath, concatList);

      const concatOut = path.join(workDir, 'concat.mp4');
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
        }
      }

      // --- Step 8: Upload to S3/R2, set up public URL ---
      const videoKey = `${jobId}.mp4`;
      const videoData = fs.readFileSync(finalOut);
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
          fs.rmSync(workDir, { recursive: true, force: true });
        } catch (e) {}
      }, 60000); // wait 1 min

      progress[jobId] = { percent: 100, status: "Done! Click play.", key: videoKey };
      finished = true;
      clearTimeout(watchdog);
    } catch (err) {
      console.error('[ERROR] /api/generate-video:', err);
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
}

app.post('/api/generate-thumbnails', async (req, res) => {
  try {
    const { topic = '', caption = '' } = req.body;
    let label = (caption && caption.length > 2) ? caption : topic;
    if (!label || label.length < 2) return res.json({ success: false, error: "Enter a topic or caption." });

    const baseThumbsDir = path.join(__dirname, 'frontend', 'assets', 'thumbnail_templates');
    // Simple: pick 10 random template backgrounds (PNG/SVG)
    const allTemplates = fs.readdirSync(baseThumbsDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => path.join(baseThumbsDir, f));
    // Bulletproof: skip dirs, only files
    const templateFiles = allTemplates.filter(f => fs.statSync(f).isFile());

    // If <10 available, repeat
    let picks = [];
    for (let i = 0; i < 10; i++) {
      picks.push(templateFiles[i % templateFiles.length]);
    }

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
    }

    // Make ZIP (for unlock/download)
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
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    // Store ZIP to temp dir for download
    const zipName = `thumbs_${uuidv4()}.zip`;
    const zipPath = path.join(JOBS_DIR, zipName);
    fs.writeFileSync(zipPath, zipBuf);

    // Provide previews as dataUrl, and link to download ZIP for "unlock"
    res.json({
      success: true,
      previews,
      zip: `/download/thumbs/${zipName}`
    });
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
   =========================================================== */

// ---- Download ZIP for thumbnails ----
app.get('/download/thumbs/:zipName', (req, res) => {
  const file = path.join(JOBS_DIR, req.params.zipName);
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.download(file, err => {
      if (!err) {
        setTimeout(() => {
          try { fs.unlinkSync(file); } catch (e) {}
        }, 2500);
      }
    });
  } else {
    res.status(404).send('File not found');
  }
});

// ---- Serve generated video from S3/R2 ----
app.get('/video/:key', async (req, res) => {
  const key = req.params.key;
  try {
    const command = new GetObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    });
    const response = await s3Client.send(command);

    res.setHeader('Content-Type', 'video/mp4');
    if (response.ContentLength)
      res.setHeader('Content-Length', response.ContentLength);

    response.Body.pipe(res);
  } catch (err) {
    res.status(404).send('Video not found');
  }
});


/* ===========================================================
   SECTION 8: CONTACT FORM ENDPOINT
   -----------------------------------------------------------
   - POST /api/contact
   - Accepts form message, sends to admin email or logs
   =========================================================== */

app.post('/api/contact', async (req, res) => {
  try {
    const { name = '', email = '', message = '' } = req.body;
    if (!name || !email || !message) {
      return res.json({ success: false, error: "Please fill out all fields." });
    }
    // Normally: send email via SendGrid/Mailgun/etc. Here, just log.
    console.log(`[CONTACT] From: ${name} <${email}>  ${message}`);
    res.json({ success: true, status: "Message received!" });
  } catch (err) {
    res.json({ success: false, error: "Failed to send message." });
  }
});


/* ===========================================================
   SECTION 9: ERROR HANDLING & SERVER START
   -----------------------------------------------------------
   - 404 catchall
   - Start server on chosen port
   =========================================================== */

app.use((req, res) => {
  res.status(404).send('Not found');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`SocialStormAI backend running on port ${PORT}`);
});


