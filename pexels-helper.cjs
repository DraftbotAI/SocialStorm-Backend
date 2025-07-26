/* ===========================================================
   PEXELS-HELPER.CJS - SocialStormAI
   -----------------------------------------------------------
   - Splits scripts into scenes
   - Finds matching clips (R2, Pexels, Pixabay), NO DUPES
   - Generates scene audio (stub, adapt as needed)
   - Combines audio & video
   - Assembles final video
   - Cleans up temp files
   - Fully async-safe, verbose logging, error-proof
   =========================================================== */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const util = require('util');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);

// === CONFIG ===
const R2_BUCKET = process.env.R2_LIBRARY_BUCKET;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const AWS = require('aws-sdk');
const s3 = new AWS.S3({
  endpoint: R2_ENDPOINT,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
  signatureVersion: 'v4'
});

// === UTILS ===
const sleep = ms => new Promise(res => setTimeout(res, ms));
const execPromise = util.promisify(exec);

function log(msg, ...args) {
  console.log(`[PEXELS-HELPER] ${msg}`, ...args);
}

// === 1. Split Script Into Scenes ===
function splitScriptToScenes(script) {
  if (!script || typeof script !== 'string') return [];
  const lines = script.split('\n').map(l => l.trim()).filter(Boolean);
  log(`splitScriptToScenes: Split into ${lines.length} scenes`);
  return lines.map((text, idx) => ({
    idx,
    text,
    audioPath: null,
    clipPath: null,
    combinedPath: null,
  }));
}

// === 2. Generate Scene Audio ===
// (This is a stub, adapt to your TTS/generation logic)
async function generateSceneAudio(scene, voice, workDir, idx) {
  try {
    // Simulate generating audio (replace with real TTS)
    const outPath = path.join(workDir, `scene${idx + 1}-audio.mp3`);
    fs.writeFileSync(outPath, Buffer.from([0x00, 0x00])); // placeholder
    log(`Audio generated for scene ${idx + 1}: ${outPath}`);
    return outPath;
  } catch (err) {
    log(`ERROR generating audio for scene ${idx + 1}: ${err.message}`);
    throw err;
  }
}

// === 3. Find Matching Clip (R2, then Pexels, then Pixabay), No Dupes ===
async function findMatchingClip(query, workDir, idx, usedClipsSet = new Set()) {
  log(`Scene ${idx + 1}: Searching for clip matching "${query}"`);
  // 1. Try R2 first
  let clipPath = null;
  let source = null;
  let triedClips = [];

  try {
    const r2Clips = await listR2ClipsMatching(query);
    for (const file of r2Clips) {
      if (!usedClipsSet.has(file.Key)) {
        triedClips.push(file.Key);
        const localClipPath = path.join(workDir, `scene${idx + 1}-r2.mp4`);
        await downloadFromR2(file.Key, localClipPath);
        clipPath = localClipPath;
        usedClipsSet.add(file.Key);
        source = 'R2';
        log(`Scene ${idx + 1}: Found R2 clip: ${file.Key}`);
        break;
      }
    }
  } catch (err) {
    log(`Scene ${idx + 1}: R2 search failed: ${err.message}`);
  }

  // 2. Fallback: Try Pexels
  if (!clipPath) {
    try {
      const pexelsClips = await searchPexelsVideos(query);
      for (const clip of pexelsClips) {
        if (!usedClipsSet.has(clip.id)) {
          triedClips.push(clip.id);
          const localClipPath = path.join(workDir, `scene${idx + 1}-pexels.mp4`);
          await downloadVideoUrl(clip.video_files[0].link, localClipPath);
          clipPath = localClipPath;
          usedClipsSet.add(clip.id);
          source = 'Pexels';
          log(`Scene ${idx + 1}: Found Pexels clip: ${clip.id}`);
          break;
        }
      }
    } catch (err) {
      log(`Scene ${idx + 1}: Pexels search failed: ${err.message}`);
    }
  }

  // 3. Fallback: Try Pixabay
  if (!clipPath) {
    try {
      const pixabayClips = await searchPixabayVideos(query);
      for (const clip of pixabayClips) {
        if (!usedClipsSet.has(clip.id)) {
          triedClips.push(clip.id);
          const localClipPath = path.join(workDir, `scene${idx + 1}-pixabay.mp4`);
          await downloadVideoUrl(clip.videos.medium.url, localClipPath);
          clipPath = localClipPath;
          usedClipsSet.add(clip.id);
          source = 'Pixabay';
          log(`Scene ${idx + 1}: Found Pixabay clip: ${clip.id}`);
          break;
        }
      }
    } catch (err) {
      log(`Scene ${idx + 1}: Pixabay search failed: ${err.message}`);
    }
  }

  if (!clipPath) {
    log(`Scene ${idx + 1}: No clip found for query "${query}" (tried: ${triedClips.join(', ')})`);
    throw new Error(`No clip found for: ${query}`);
  }

  log(`Scene ${idx + 1}: Using ${source} clip: ${clipPath}`);
  return clipPath;
}

// === 4. Combine Audio and Clip ===
async function combineAudioAndClip(audioPath, clipPath, workDir, idx) {
  const outPath = path.join(workDir, `scene${idx + 1}-combo.mp4`);
  log(`Combining audio (${audioPath}) and video (${clipPath}) → ${outPath}`);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(clipPath)
      .input(audioPath)
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v copy',
        '-c:a aac',
        '-shortest'
      ])
      .on('end', () => {
        log(`Combined scene ${idx + 1} → ${outPath}`);
        resolve(outPath);
      })
      .on('error', (err) => {
        log(`ERROR combining scene ${idx + 1}: ${err.message}`);
        reject(err);
      })
      .save(outPath);
  });
}

// === 5. Assemble Final Video ===
async function assembleFinalVideo(scenes, workDir) {
  const concatListPath = path.join(workDir, 'concat.txt');
  const outputPath = path.join(workDir, 'final.mp4');
  try {
    // Write ffmpeg concat list
    fs.writeFileSync(concatListPath, scenes.map(scene =>
      `file '${scene.combinedPath.replace(/\\/g, '/')}'`
    ).join('\n'));

    log(`Assembling final video using list: ${concatListPath}`);
    await execPromise(`${ffmpegPath} -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`);
    log(`Final video assembled: ${outputPath}`);
    return outputPath;
  } catch (err) {
    log(`ERROR assembling final video: ${err.message}`);
    throw err;
  }
}

// === 6. Cleanup Job ===
function cleanupJob(jobId) {
  // Remove job folder and all contents
  try {
    const jobDir = path.join(__dirname, 'jobs', jobId);
    if (fs.existsSync(jobDir)) {
      fs.rmSync(jobDir, { recursive: true, force: true });
      log(`Job folder cleaned up: ${jobDir}`);
    }
  } catch (err) {
    log(`ERROR cleaning up job ${jobId}: ${err.message}`);
  }
}

// === Helper: List R2 Clips Matching Query ===
async function listR2ClipsMatching(query) {
  const prefix = query
    .toLowerCase()
    .replace(/[^a-z0-9\- ]/gi, '')
    .replace(/\s+/g, '-');
  const params = {
    Bucket: R2_BUCKET,
    Prefix: prefix
  };
  const res = await s3.listObjectsV2(params).promise();
  // Filter only video files
  return (res.Contents || []).filter(obj => obj.Key.endsWith('.mp4'));
}

// === Helper: Download File from R2 ===
async function downloadFromR2(key, destPath) {
  const params = { Bucket: R2_BUCKET, Key: key };
  const res = await s3.getObject(params).promise();
  fs.writeFileSync(destPath, res.Body);
  log(`Downloaded R2 file ${key} → ${destPath}`);
}

// === Helper: Search Pexels Videos ===
async function searchPexelsVideos(query) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) throw new Error('PEXELS_API_KEY not set');
  const res = await axios.get(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=10`,
    { headers: { Authorization: apiKey } }
  );
  return res.data.videos || [];
}

// === Helper: Search Pixabay Videos ===
async function searchPixabayVideos(query) {
  const apiKey = process.env.PIXABAY_API_KEY;
  if (!apiKey) throw new Error('PIXABAY_API_KEY not set');
  const res = await axios.get(
    `https://pixabay.com/api/videos/?key=${apiKey}&q=${encodeURIComponent(query)}&per_page=10`
  );
  return res.data.hits || [];
}

// === Helper: Download Video URL ===
async function downloadVideoUrl(url, destPath) {
  const res = await axios.get(url, { responseType: 'stream' });
  const writer = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.data.pipe(writer);
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
  log(`Downloaded video: ${url} → ${destPath}`);
}

// === EXPORTS ===
module.exports = {
  splitScriptToScenes,
  generateSceneAudio,
  findMatchingClip,
  combineAudioAndClip,
  assembleFinalVideo,
  cleanupJob
};


console.log('\n===========[ PEXELS HELPER LOADED | GOD TIER LOGGING READY ]============');
