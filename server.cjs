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
// 4. PROGRESS TRACKING MAP & CLEANUP
// ==========================================

const progressMap = {};
const JOB_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Schedule cleanup of a job's progress info after a delay.
 * Logs cleanup activity.
 * @param {string} jobId - Unique job ID to clean up
 * @param {number} delay - Delay in milliseconds before cleanup (default 5 minutes)
 */
function cleanupJob(jobId, delay = JOB_TTL_MS) {
  console.log(`[4] Scheduling cleanup for job ${jobId} in ${delay / 1000}s`);
  setTimeout(() => {
    if (progressMap[jobId]) {
      delete progressMap[jobId];
      console.log(`[4] Cleaned up job progress: ${jobId}`);
    } else {
      console.log(`[4] Job ${jobId} already cleaned or missing.`);
    }
  }, delay);
}

module.exports = { progressMap, cleanupJob };



// ==========================================
// 5. EXPRESS APP INITIALIZATION
// ==========================================
const app = express();
app.use((req, res, next) => {
  console.log(`[5] [${new Date().toISOString()}] ${req.method} ${req.url} — body:`, JSON.stringify(req.body || {}));
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
// 7. HELPERS, CLIP SOURCING, VOICES, LOGGING
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

// --- 1. Cloudflare R2 CLIP SEARCH & DOWNLOAD ---
async function getR2ClipList(safe = false) {
  try {
    // THIS is the correct prefix for your bucket structure!
    const { Contents } = await s3.listObjectsV2({
      Bucket: process.env.R2_BUCKET,
      Prefix: 'socialstorm-library/'
    }).promise();
    const list = (Contents || []).map(obj => obj.Key).filter(Boolean).filter(k => k.match(/\.(mp4|mov|webm)$/));
    if (!list.length) throw new Error("No clips in R2");
    console.log(`[7] getR2ClipList: Found ${list.length} clips in R2. Example:`, list[0]);
    return list;
  } catch (err) {
    if (!safe) throw err;
    console.warn('[7] getR2ClipList error:', err);
    return [];
  }
}

async function downloadFromR2ToFile(r2Key, dest) {
  try {
    const { Body } = await s3.getObject({
      Bucket: process.env.R2_BUCKET,
      Key: r2Key
    }).promise();
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.writeFile(dest, Body);
    console.log(`[7] R2 clip downloaded: ${r2Key} -> ${dest}`);
    return dest;
  } catch (err) {
    console.warn(`[7] downloadFromR2ToFile failed: ${err.message}`);
    return null;
  }
}

async function findR2Clip(sceneText, usedClipPaths = []) {
  const clipList = await getR2ClipList(true);
  const available = clipList.filter(k => !usedClipPaths.includes(k));
  if (!available.length) {
    console.warn('[7] findR2Clip: No available clips in R2!');
    return null;
  }
  const names = available.map(key => key.toLowerCase());
  const keywords = [extractMainSubject(sceneText), ...sanitizeQuery(sceneText).split(' ').slice(0, 2), 'nature', 'animal', 'background'];
  // Combine all keywords into a search string for bestMatch
  const { bestMatch } = stringSimilarity.findBestMatch(keywords.join(' '), names);
  const chosenKey = available[bestMatch.rating > 0.2 ? names.indexOf(bestMatch.target) : 0];
  const localDest = path.join(process.cwd(), 'tmp', 'r2clips', path.basename(chosenKey));
  await downloadFromR2ToFile(chosenKey, localDest);
  console.log(`[7] findR2Clip: Selected R2 clip: ${chosenKey}`);
  return localDest;
}

// --- 2. PEXELS CLIP SEARCH & DOWNLOAD ---
async function findPexelsClip(sceneText, workDir) {
  try {
    const baseQuery = extractMainSubject(sceneText) || 'nature';
    const apiKey = process.env.PEXELS_API_KEY;
    if (!apiKey) throw new Error('Missing PEXELS_API_KEY');
    const queries = [baseQuery];
    if (!baseQuery.toLowerCase().includes('nature')) queries.push('nature');
    if (!baseQuery.toLowerCase().includes('animal')) queries.push('animal');
    let lastVideos = [];
    for (const query of queries) {
      const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5`;
      console.log(`[7] findPexelsClip: Searching Pexels for query: "${query}"`);
      const resp = await axios.get(url, { headers: { Authorization: apiKey } });
      const videos = resp.data.videos || [];
      lastVideos = videos.length > 0 ? videos : lastVideos;
      if (videos.length > 0) {
        let bestVideo = null;
        let bestScore = 0;
        for (const vid of videos) {
          const combined = (vid.user?.name || '') + ' ' + (vid.url || '');
          const sim = stringSimilarity.compareTwoStrings(sceneText.toLowerCase(), combined.toLowerCase());
          if (sim > bestScore) {
            bestScore = sim;
            bestVideo = vid;
          }
        }
        if (!bestVideo) bestVideo = videos[0];
        const clipUrl = bestVideo.video_files.find(f => f.quality === "hd" || f.quality === "sd")?.link || bestVideo.video_files[0]?.link;
        if (clipUrl) {
          const dest = path.join(workDir, `pexels_${Date.now()}.mp4`);
          const writer = fs.createWriteStream(dest);
          const response = await axios.get(clipUrl, { responseType: 'stream' });
          await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });
          console.log(`[7] findPexelsClip: Downloaded clip for query "${query}" -> ${dest}`);
          return dest;
        }
      }
    }
    if (lastVideos.length > 0) {
      const vid = lastVideos[0];
      const clipUrl = vid.video_files.find(f => f.quality === "hd" || f.quality === "sd")?.link || vid.video_files[0]?.link;
      if (clipUrl) {
        const dest = path.join(workDir, `pexels_fallback_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(dest);
        const response = await axios.get(clipUrl, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.warn(`[7] findPexelsClip: No strong match, using first available clip for fallback.`);
        return dest;
      }
    }
    console.warn(`[7] findPexelsClip: No video found for any query derived from "${sceneText}"`);
    return null;
  } catch (err) {
    console.warn(`[7] Pexels search/download failed: ${err.message}`);
    return null;
  }
}

// --- 3. PIXABAY CLIP SEARCH & DOWNLOAD ---
async function findPixabayClip(sceneText, workDir) {
  try {
    const query = extractMainSubject(sceneText) || 'nature';
    const apiKey = process.env.PIXABAY_API_KEY;
    if (!apiKey) throw new Error('Missing PIXABAY_API_KEY');
    const url = `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=5&safesearch=true`;
    console.log(`[7] findPixabayClip: Searching Pixabay for query: "${query}"`);
    const resp = await axios.get(url);
    const hits = resp.data.hits || [];
    if (hits.length) {
      let bestHit = null;
      let bestScore = 0;
      for (const vid of hits) {
        const combined = (vid.tags || '') + ' ' + (vid.user || '') + ' ' + (vid.pageURL || '');
        const sim = stringSimilarity.compareTwoStrings(sceneText.toLowerCase(), combined.toLowerCase());
        if (sim > bestScore) {
          bestScore = sim;
          bestHit = vid;
        }
      }
      if (!bestHit) bestHit = hits[0];
      const sources = Object.values(bestHit.videos || {});
      const bestSource = sources.find(s => s.url) || sources[0];
      if (bestSource && bestSource.url) {
        const dest = path.join(workDir, `pixabay_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(dest);
        const response = await axios.get(bestSource.url, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.log(`[7] findPixabayClip: Downloaded clip -> ${dest}`);
        return dest;
      }
    }
    // Fallback
    if (hits.length > 0) {
      const vid = hits[0];
      const sources = Object.values(vid.videos || {});
      const bestSource = sources.find(s => s.url) || sources[0];
      if (bestSource && bestSource.url) {
        const dest = path.join(workDir, `pixabay_fallback_${Date.now()}.mp4`);
        const writer = fs.createWriteStream(dest);
        const response = await axios.get(bestSource.url, { responseType: 'stream' });
        await new Promise((resolve, reject) => {
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
        console.warn(`[7] findPixabayClip: No strong match, using first available clip for fallback.`);
        return dest;
      }
    }
    console.warn(`[7] findPixabayClip: No videos found for query "${query}"`);
    return null;
  } catch (err) {
    console.warn(`[7] Pixabay search/download failed: ${err.message}`);
    return null;
  }
}

// --- 4. Main helper: ALWAYS returns best available clip ---
async function findBestClipForScene(sceneText, workDir, usedClipPaths = []) {
  console.log(`[7] Finding best clip for scene: "${sceneText}"`);

  // 1. Cloudflare R2
  const r2Clip = await findR2Clip(sceneText, usedClipPaths);
  if (r2Clip && fs.existsSync(r2Clip)) return r2Clip;

  // 2. Pexels
  const pexelsClip = await findPexelsClip(sceneText, workDir);
  if (pexelsClip && fs.existsSync(pexelsClip)) return pexelsClip;

  // 3. Pixabay
  const pixabayClip = await findPixabayClip(sceneText, workDir);
  if (pixabayClip && fs.existsSync(pixabayClip)) return pixabayClip;

  // Final safeguard: reuse any available R2 clip
  const fallbackList = await getR2ClipList(true);
  if (fallbackList.length > 0) {
    const fallbackKey = fallbackList[0];
    const localDest = path.join(workDir, `fallback_${Date.now()}.mp4`);
    await downloadFromR2ToFile(fallbackKey, localDest);
    console.warn(`[7] Ultimate fallback: Using any available R2 clip: ${fallbackKey}`);
    return localDest;
  }

  // Emergency fallback: local blank
  const blankPath = path.join(__dirname, 'assets', 'blank.mp4');
  console.error(`[7] Emergency fallback: No clips found, using blank.mp4`);
  return blankPath;
}

// ========== ALL VOICES (FULL) ==========
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

console.log('[7] All helper utilities, clip finders, and voices loaded.');



// ==========================================
// 8. VIRAL METADATA ENGINE (FULL LOGGING)
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

    console.log("[8] Requesting viral metadata from OpenAI...");
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
    console.log("[8] Metadata from OpenAI:", { title, description, tags });
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
// 9. SCRIPT-TO-SCENES SPLITTER (FULL LOGGING)
// ==========================================
function splitScriptToScenes(script) {
  const scenes = (script || "")
    .split(/(?<=[.!?])\s+|\n/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => line.length > 1);
  console.log(`[9] splitScriptToScenes: Split into ${scenes.length} scenes`);
  return scenes;
}




// ==========================================
// 10. ELEVENLABS & POLLY TTS SYNTHESIZER (FULL LOGGING, GLOBAL EXPORT)
// ==========================================


const fs = require('fs');
const axios = require('axios');

// -- ELEVENLABS TTS SYNTHESIZER --
async function synthesizeWithElevenLabs(text, voice, outFile) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error("No ElevenLabs API Key");
    console.log(`[10] synthesizeWithElevenLabs: "${voice}" => ${outFile} | Text: "${text}"`);
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      { text, model_id: "eleven_monolingual_v1" },
      { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY }, responseType: "arraybuffer" }
    );
    fs.writeFileSync(outFile, ttsRes.data);
    console.log(`[10] ElevenLabs audio written: ${outFile}`);
    return outFile;
  } catch (err) {
    console.error("[10] ElevenLabs error:", err.message);
    throw new Error("ElevenLabs error: " + err.message);
  }
}

// -- POLLY TTS SYNTHESIZER --
async function synthesizeWithPolly(text, voice, outFile) {
  const params = {
    Text: text,
    OutputFormat: "mp3",
    VoiceId: voice,
    Engine: "neural"
  };
  console.log(`[10] synthesizeWithPolly: "${voice}" => ${outFile} | Text: "${text}"`);
  return new Promise((resolve, reject) => {
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        console.error("[10] Polly error:", err.message);
        return reject(new Error("Polly error: " + err.message));
      }
      if (data && data.AudioStream instanceof Buffer) {
        fs.writeFileSync(outFile, data.AudioStream);
        console.log(`[10] Polly audio written: ${outFile}`);
        resolve(outFile);
      } else {
        reject(new Error("Polly synthesis failed, no audio stream."));
      }
    });
  });
}

// -- MAIN GLOBAL SCENE AUDIO GENERATOR --
// This will pick ElevenLabs if 'voice' is an ElevenLabs ID, Polly otherwise. You can expand logic.
global.generateSceneAudio = async function (sceneText, voice) {
  try {
    if (!sceneText || !voice) throw new Error("Missing sceneText or voice");
    // Pick provider by voice string pattern (adjust this logic as needed)
    const isElevenLabs = typeof voice === 'string' && voice.match(/^([a-z0-9]{20,})$/i); // crude: IDs look like hash
    const outDir = path.join(__dirname, 'audio');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `scene_${Date.now()}_${Math.random().toString(36).slice(2,8)}.mp3`);

    if (isElevenLabs) {
      return await synthesizeWithElevenLabs(sceneText, voice, outFile);
    } else {
      return await synthesizeWithPolly(sceneText, voice, outFile);
    }
  } catch (err) {
    console.error(`[10] [generateSceneAudio] ERROR: ${err.stack || err}`);
    throw err;
  }
};



// ==========================================
// 11. /api/voices ENDPOINT (FULL LOGGING)
// ==========================================
app.get('/api/voices', (req, res) => {
  console.log("[11] /api/voices endpoint called.");
  const mappedCustomVoices = [...pollyVoices, ...elevenProVoices];
  res.json({ success: true, voices: mappedCustomVoices });
});


// ==========================================
// 12. /api/generate-script ENDPOINT
// ==========================================
app.post('/api/generate-script', async (req, res) => {
  console.log("[12] /api/generate-script endpoint called.");
  const ideaRaw = req.body.idea;
  if (typeof ideaRaw !== "string" || !ideaRaw.trim()) {
    console.warn("[12] Invalid or missing 'idea' parameter.");
    return res.status(400).json({ success: false, error: "Invalid or missing 'idea' parameter." });
  }
  const idea = ideaRaw.trim();
  try {
    if (!openai || !process.env.OPENAI_API_KEY) {
      console.error("[12] OpenAI unavailable.");
      return res.status(503).json({ success: false, error: "OpenAI unavailable." });
    }

    // FORCE hook in first line, no numbers, no quotes
    const hookPrompt = `
Write a viral short-form video script for the topic: "${idea}".
Rules:
- The FIRST sentence must introduce the topic in a punchy, curiosity-driven way.
- DO NOT use "Line 1", "Line 2", or any line numbers.
- DO NOT add quotes around the lines.
- Each sentence must be on its own line.
- Start with a strong hook sentence.
- Keep it punchy, engaging, and suitable for TikTok or YouTube Shorts.
- Limit the script to under 60 seconds total.
Format (NO numbering or quotes):

Your first punchy sentence here.
Next sentence here.
Another punchy line.
Final sentence.
`.trim();

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

    // STRIP line numbers and quotes from each line, but KEEP strong opener
    let scriptLines = script.split(/\r?\n/).map(line =>
      line.replace(/^line\s*\d+[:\-\.]?\s*/i, '')
          .replace(/^["']|["']$/g, '')
          .trim()
    ).filter(line => line.length > 0);

    // If the first line is somehow NOT a hook, keep as is — you want it!
    script = scriptLines.join('\n');

    const viralMeta = await generateViralMetadata(script);
    console.log("[12] Script generated:", script);
    console.log("[12] Metadata:", viralMeta);

    return res.json({
      success: true,
      script,
      title: viralMeta.title,
      description: viralMeta.description,
      tags: viralMeta.tags
    });
  } catch (error) {
    console.error("[12] Error generating script:", error);
    return res.status(500).json({ success: false, error: "Failed to generate script. Try again." });
  }
});



// ==========================================
// 13. SPARKIE (IDEA GENERATOR) ENDPOINT (FULL LOGGING)
// ==========================================
app.post('/api/sparkie', async (req, res) => {
  console.log("[13] /api/sparkie endpoint called.");
  const { prompt } = req.body;
  if (!prompt) {
    console.warn("[13] Prompt required.");
    return res.status(400).json({ success: false, error: 'Prompt required' });
  }
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
    console.log("[13] Sparkie ideas generated:", c.choices[0].message.content.trim());
    return res.json({ success: true, ideas: c.choices[0].message.content.trim() });
  } catch (e) {
    console.error("[13] Sparkie error:", e);
    return res.status(500).json({ success: false, error: e.message });
  }
});



// ==========================================
// 14. /api/generate-thumbnails ENDPOINT (FULL LOGGING)
// ==========================================

app.post('/api/generate-thumbnails', async (req, res) => {
  console.log("[14] /api/generate-thumbnails endpoint called.");
  const { topic } = req.body;
  if (!topic) {
    console.warn("[14] Topic required.");
    return res.status(400).json({ success: false, error: 'Topic required' });
  }

  // Use topic and add font/caption
  const fontFiles = [
    'Impact.ttf','Anton-Regular.ttf','BebasNeue-Regular.ttf','LeagueGothic-Regular.ttf','Oswald-Regular.ttf','Montserrat-Bold.ttf','Poppins-Bold.ttf','Raleway-Black.ttf','Roboto-Bold.ttf','ArchivoBlack-Regular.ttf'
  ];
  fontFiles.forEach((font, i) => {
    try { registerFont(path.join(__dirname, 'fonts', font), { family: `ViralFont${i}` }); }
    catch (err) { console.warn(`[14] Could not register font: ${font}`); }
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
    console.log(`[14] Generated thumbnail ${i + 1} for topic "${topic}"`);
  }
  return res.json({ success: true, thumbnails });
});


// ...end of Section 14...

// ==========================================
// Defensive Helper Aliases for Consistency (goes before Section 15)
// ==========================================

// Always checks global.<funcname> so there's NO ReferenceError even if not defined yet.
const parseScriptToScenes = (typeof global.splitScriptToScenes === 'function')
  ? global.splitScriptToScenes
  : (script) => (typeof script === 'string' && script.trim()) ? script.split('\n').filter(Boolean) : [];

const findMatchingClip = (typeof global.findBestClipForScene === 'function')
  ? global.findBestClipForScene
  : async (sceneText) => {
      console.warn('[findMatchingClip fallback] No local/video clip logic implemented!');
      return null;
    };

const generateSceneAudio = (typeof global.generateSceneAudio === 'function')
  ? global.generateSceneAudio
  : async (sceneText, voice) => {
      console.warn('[generateSceneAudio fallback] Not implemented!');
      return null;
    };

const combineAudioAndClipDef = (typeof global.combineAudioAndClip === 'function')
  ? global.combineAudioAndClip
  : async (audioPath, videoPath, outputPath) => {
      console.warn('[combineAudioAndClip fallback] Not implemented!');
      return null;
    };

const assembleFinalVideo = (typeof global.assembleFinalVideo === 'function')
  ? global.assembleFinalVideo
  : async (sceneFiles, opts) => {
      console.warn('[assembleFinalVideo fallback] Not implemented!');
      return null;
    };

const uploadVideoToR2 = (typeof global.uploadVideoToR2 === 'function')
  ? global.uploadVideoToR2
  : async (videoPath) => {
      console.warn('[uploadVideoToR2 fallback] Not implemented!');
      return null;
    };

// ==========================================
// 15. /api/generate-video ENDPOINT (MAIN VIDEO GENERATION LOGIC)
// ==========================================
app.post('/api/generate-video', async (req, res) => {
  const jobId = uuidv4();
  const startTime = Date.now();
  const progressKey = jobId;
  progressMap[progressKey] = { percent: 0, status: "Starting...", started: new Date().toISOString() };
  console.log(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] Video generation started`);

  try {
    // 1. Extract request data
    const { script, voice, paidUser, removeWatermark } = req.body;
    if (!script || !voice) {
      progressMap[progressKey] = { percent: 0, status: "Script or voice missing.", error: true };
      return res.status(400).json({ success: false, error: "Script and voice are required." });
    }

    // 2. Parse script into scenes (now using safe wrapper)
    let scenes = [];
    try {
      scenes = parseScriptToScenes(script); // <-- SAFER: always available
      console.log(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] Script split into ${scenes.length} scenes.`);
      if (!Array.isArray(scenes) || scenes.length === 0) throw new Error("Script parsing yielded no scenes.");
    } catch (e) {
      progressMap[progressKey] = { percent: 0, status: "Script parsing failed.", error: true };
      console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] ERROR parsing script: ${e.stack || e}`);
      return res.status(400).json({ success: false, error: "Script parsing failed." });
    }

    // 3. Main processing: one scene at a time
    let sceneClips = [];
    for (let i = 0; i < scenes.length; i++) {
      const sceneText = scenes[i];
      const stepMsg = `[generate-video] [jobId: ${jobId}] Scene ${i+1}/${scenes.length}`;
      try {
        progressMap[progressKey] = { percent: Math.round((i / scenes.length) * 80), status: `Rendering scene ${i+1} of ${scenes.length}` };
        console.log(`[15] [${new Date().toISOString()}] ${stepMsg}: Starting. Text: "${sceneText}"`);

        // 3a. Generate audio
        let audioPath;
        try {
          audioPath = await generateSceneAudio(sceneText, voice); // Always safe, see above
          if (!audioPath) throw new Error("Audio path not returned");
          console.log(`[15] [${new Date().toISOString()}] ${stepMsg}: Audio generated at ${audioPath}`);
        } catch (err) {
          console.error(`[15] [${new Date().toISOString()}] ${stepMsg}: AUDIO FAIL - ${err.stack || err}`);
          progressMap[progressKey] = { percent: Math.round((i / scenes.length) * 80), status: `Audio failed on scene ${i+1}`, error: true };
          throw new Error(`Audio generation failed for scene ${i+1}: ${err.message}`);
        }

        // 3b. Select video clip (cloud > local > Pexels)
        let videoPath;
        try {
          videoPath = await findMatchingClip(sceneText);
          if (!videoPath) throw new Error("No video path returned");
          console.log(`[15] [${new Date().toISOString()}] ${stepMsg}: Video found at ${videoPath}`);
        } catch (err) {
          console.error(`[15] [${new Date().toISOString()}] ${stepMsg}: VIDEO FAIL - ${err.stack || err}`);
          progressMap[progressKey] = { percent: Math.round((i / scenes.length) * 80), status: `Video failed on scene ${i+1}`, error: true };
          throw new Error(`Video selection failed for scene ${i+1}: ${err.message}`);
        }

        // 3c. Combine audio and video for scene
        let sceneOutput;
        const outputPath = path.join(__dirname, 'tmp', `scene_${jobId}_${i+1}.mp4`);
        try {
          sceneOutput = await combineAudioAndClipDef(audioPath, videoPath, outputPath);
          if (!sceneOutput) throw new Error("Scene output path missing");
          console.log(`[15] [${new Date().toISOString()}] ${stepMsg}: Scene created at ${sceneOutput}`);
          sceneClips.push(sceneOutput);
        } catch (err) {
          console.error(`[15] [${new Date().toISOString()}] ${stepMsg}: COMBINE FAIL - ${err.stack || err}`);
          progressMap[progressKey] = { percent: Math.round((i / scenes.length) * 80), status: `Failed to combine audio/video on scene ${i+1}`, error: true };
          throw new Error(`Scene combine failed for scene ${i+1}: ${err.message}`);
        }

      } catch (sceneError) {
        progressMap[progressKey] = { percent: Math.round((i / scenes.length) * 80), status: `Stopped: ${sceneError.message}`, error: true };
        console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] FATAL scene error: ${sceneError.stack || sceneError}`);
        break;
      }
    }

    if (sceneClips.length !== scenes.length) {
      progressMap[progressKey] = { percent: 100, status: "Generation failed: Not all scenes processed.", error: true };
      console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] ERROR: Only ${sceneClips.length} of ${scenes.length} scenes rendered. Aborting.`);
      return res.status(500).json({ success: false, error: "Not all scenes rendered, check logs." });
    }

    // 4. Concat all scenes
    let finalVideoPath = null;
    try {
      progressMap[progressKey] = { percent: 82, status: "Concatenating scenes…" };
      finalVideoPath = await assembleFinalVideo(sceneClips);
      if (!finalVideoPath) throw new Error("Final video concat failed");
      console.log(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] Final video assembled at ${finalVideoPath}`);
    } catch (err) {
      progressMap[progressKey] = { percent: 83, status: "Concat failed.", error: true };
      console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] CONCAT ERROR: ${err.stack || err}`);
      return res.status(500).json({ success: false, error: "Concat failed." });
    }

    // 5. Upload to Cloudflare R2 (or wherever)
    let videoKey = null;
    try {
      progressMap[progressKey] = { percent: 89, status: "Uploading…" };
      videoKey = await uploadVideoToR2(finalVideoPath);
      if (!videoKey) throw new Error("Upload failed");
      console.log(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] Uploaded to R2 key: ${videoKey}`);
    } catch (err) {
      progressMap[progressKey] = { percent: 90, status: "Upload failed.", error: true };
      console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] UPLOAD ERROR: ${err.stack || err}`);
      return res.status(500).json({ success: false, error: "Upload failed." });
    }

    // 6. All done!
    progressMap[progressKey] = { percent: 100, status: "Done!", key: videoKey, completed: new Date().toISOString() };
    console.log(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] Done! All scenes processed, video ready. Total time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    return res.json({ success: true, jobId, key: videoKey });

  } catch (fatalError) {
    progressMap[progressKey] = { percent: 100, status: `Fatal error: ${fatalError.message}`, error: true };
    console.error(`[15] [${new Date().toISOString()}] [generate-video] [jobId: ${jobId}] UNCAUGHT FATAL ERROR: ${fatalError.stack || fatalError}`);
    return res.status(500).json({ success: false, error: "Fatal error in video generation.", details: fatalError.message });
  }
});



// ==========================================
// 16. PROGRESS POLLING ENDPOINT (FIXED TO USE progressMap)
// ==========================================
app.get('/api/progress/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = progressMap[jobId];
  if (!job) {
    console.warn('[16] /api/progress: Job not found or expired for', jobId);
    return res.json({ percent: 100, status: 'Failed: Job not found or expired.' });
  }
  console.log('[16] /api/progress:', jobId, job);
  res.json(job);
});




// ==========================================
// 17. GENERATE VOICE PREVIEWS ENDPOINT
// ==========================================
app.post('/api/generate-voice-previews', async (req, res) => {
  const sampleText = "This is a sample of my voice.";
  console.log('[17] /api/generate-voice-previews endpoint called.');
  try {
    for (const v of pollyVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithPolly(sampleText, v.id, filePath);
        console.log(`[17] Polly preview generated: ${filePath}`);
      } else {
        console.log(`[17] Polly preview exists: ${filePath}`);
      }
    }
    for (const v of elevenProVoices) {
      const filePath = path.join(__dirname, 'frontend', 'voice-previews', `${v.id}.mp3`);
      if (!fs.existsSync(filePath)) {
        await synthesizeWithElevenLabs(sampleText, v.id, filePath);
        console.log(`[17] ElevenLabs preview generated: ${filePath}`);
      } else {
        console.log(`[17] ElevenLabs preview exists: ${filePath}`);
      }
    }
    res.json({ success: true, message: "Voice previews generated." });
  } catch (err) {
    console.error("[17] Voice preview generation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});



// ==========================================
// 18. SERVE VIDEOS FROM LOCAL TMP (PROD: SWAP TO R2)
// ==========================================
app.get('/video/videos/:key', async (req, res) => {
  const keyParam = req.params.key;
  const filePath = path.join(__dirname, 'tmp', keyParam);
  console.log(`[18] /video/videos/:key endpoint called. File: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    console.error(`[18] Video not found: ${filePath}`);
    res.status(404).end('Video not found');
    return;
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="socialstorm-video.mp4"');
  fs.createReadStream(filePath)
    .on('error', err => {
      console.error(`[18] Error streaming video:`, err);
      res.status(500).end('Error streaming video');
    })
    .pipe(res);
});



// ==========================================
// 19. PRETTY URLs FOR .HTML PAGES
// ==========================================
app.get('/*.html', (req, res) => {
  const htmlPath = path.join(__dirname, 'frontend', req.path.replace(/^\//, ''));
  if (fs.existsSync(htmlPath) && !fs.lstatSync(htmlPath).isDirectory()) {
    res.sendFile(htmlPath);
    console.log(`[19] Sent HTML file: ${htmlPath}`);
  } else {
    console.warn(`[19] HTML file not found: ${htmlPath}`);
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
      console.log(`[20] Sent fallback HTML file: ${htmlPath}`);
    } else {
      const fallback = path.join(__dirname, 'frontend', 'index.html');
      res.sendFile(fallback);
      console.log(`[20] Sent index.html as fallback.`);
    }
  } else {
    res.status(404).json({ error: 'Not found.' });
    console.warn(`[20] Not found for API or video route: ${req.path}`);
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
