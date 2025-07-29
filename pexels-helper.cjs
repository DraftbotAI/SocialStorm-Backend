/* ===========================================================
   PEXELS HELPER – SocialStormAI
   -----------------------------------------------------------
   - Finds the best-matching video clip for a scene.
   - Search order: R2 > Pexels > Pixabay (fallback)
   - If no video: gets an image, creates a slow pan video (L→R or R→L)
   - Improved visual subject extraction (no AI, just rules)
   - Handles all download/streaming and normalization.
   - **MAXIMUM LOGGING IN EVERY FUNCTION**
   =========================================================== */

const AWS = require('aws-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

// ENV
const R2_LIBRARY_BUCKET = process.env.R2_LIBRARY_BUCKET || 'socialstorm-library';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PIXABAY_API_KEY = process.env.PIXABAY_API_KEY;

// --- IMPROVED Visual Subject Picker (Rule-Based, No AI) ---
function extractVisualSubject(line, title = '') {
  console.log(`[EXTRACT] Starting extractVisualSubject | line="${line}" | title="${title}"`);
  const famousSubjects = [
    "statue of liberty", "eiffel tower", "taj mahal", "mount rushmore", "great wall of china",
    "disney", "vatican", "empire state building", "sphinx", "london bridge", "lincoln memorial",
    "big ben", "colosseum", "golden gate bridge", "brooklyn bridge", "machu picchu",
    "trevi fountain", "niagara falls", "burj khalifa", "space needle", "grand canyon", "sydney opera house"
  ];

  let text = `${line} ${title || ''}`.toLowerCase();
  for (let name of famousSubjects) {
    if (text.includes(name)) {
      console.log(`[EXTRACT] Matched famous subject: "${name}"`);
      return name;
    }
  }

  const proper = line.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
  if (proper) {
    console.log(`[EXTRACT] Matched proper noun: "${proper[1]}"`);
    return proper[1];
  }

  const capWord = line.match(/\b([A-Z][a-z]+)\b/);
  if (capWord) {
    console.log(`[EXTRACT] Matched single capitalized word: "${capWord[1]}"`);
    return capWord[1];
  }

  const words = line.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].length > 3 && /^[a-zA-Z]+$/.test(words[i])) {
      console.log(`[EXTRACT] Fallback: using last noun-like word: "${words[i]}"`);
      return words[i];
    }
  }

  if (title) {
    console.log(`[EXTRACT] Fallback: using title "${title}"`);
    return title;
  }
  console.log(`[EXTRACT] Ultimate fallback: using full line "${line}"`);
  return line;
}

// --- Util: Normalize subject and filenames for matching ---
function normalize(str) {
  const norm = String(str)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
  console.log(`[NORMALIZE] Input: "${str}" → Normalized: "${norm}"`);
  return norm;
}

// --- R2 CLIP MATCHING ---
async function listAllFilesInR2(s3Client, prefix = '') {
  console.log(`[R2] listAllFilesInR2 | prefix="${prefix}"`);
  let files = [];
  let continuationToken = undefined;
  let round = 0;
  try {
    do {
      round++;
      console.log(`[R2] Fetching R2 file list (round ${round})...`);
      const cmd = new ListObjectsV2Command({
        Bucket: R2_LIBRARY_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const resp = await s3Client.send(cmd);
      if (resp && resp.Contents) {
        console.log(`[R2] Retrieved ${resp.Contents.length} files (round ${round})`);
        files.push(...resp.Contents.map(obj => obj.Key));
      } else {
        console.log(`[R2] No files in resp.Contents for round ${round}`);
      }
      continuationToken = resp.NextContinuationToken;
      if (continuationToken) {
        console.log(`[R2] NextContinuationToken present; will fetch more...`);
      }
    } while (continuationToken);
    console.log(`[R2] Total files listed from R2: ${files.length}`);
    return files;
  } catch (err) {
    console.error('[R2] Error in listAllFilesInR2:', err);
    return [];
  }
}

async function findClipInR2(subject, s3Client) {
  console.log(`[R2] findClipInR2 | subject="${subject}"`);
  if (!s3Client) {
    console.error('[R2] s3Client not provided!');
    throw new Error('[R2] s3Client not provided!');
  }
  try {
    const files = await listAllFilesInR2(s3Client, '');
    const normQuery = normalize(subject);
    console.log(`[R2] Looking for: "${subject}" → normalized: "${normQuery}" in ${files.length} files`);

    let best = null;
    // 1. Exact match (whole phrase)
    for (let file of files) {
      const normFile = normalize(file);
      if (normFile.includes(normQuery)) {
        best = file;
        console.log(`[R2] Exact/whole phrase match: "${file}"`);
        break;
      }
    }
    // 2. Partial match (all words must appear somewhere)
    if (!best) {
      const words = subject.split(/\s+/).map(normalize).filter(Boolean);
      for (let file of files) {
        const normFile = normalize(file);
        if (words.every(w => normFile.includes(w))) {
          best = file;
          console.log(`[R2] Partial/all-word match: "${file}"`);
          break;
        }
      }
    }
    if (best) {
      let url = R2_ENDPOINT.endsWith('/') ? R2_ENDPOINT : (R2_ENDPOINT + '/');
      url += `${R2_LIBRARY_BUCKET}/${best}`;
      console.log(`[R2] Found match: ${best} → ${url}`);
      return url;
    }
    console.log(`[R2] No match found for: "${subject}" after scanning ${files.length} files`);
    return null;
  } catch (err) {
    console.error('[R2] Error listing or matching:', err);
    return null;
  }
}

// --- PEXELS VIDEO FALLBACK ---
async function findClipInPexels(subject) {
  console.log(`[PEXELS] findClipInPexels | subject="${subject}"`);
  if (!PEXELS_API_KEY) {
    console.warn('[PEXELS] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/videos/search?query=${query}&per_page=5`;
    console.log(`[PEXELS] Request: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.videos && resp.data.videos.length > 0) {
      console.log(`[PEXELS] ${resp.data.videos.length} videos found for "${subject}"`);
      const sorted = resp.data.videos.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const bestClip = sorted[0];
      console.log(`[PEXELS] Best video: ID=${bestClip.id}, duration=${bestClip.duration}, width=${bestClip.width}, height=${bestClip.height}`);
      const fileLink = bestClip.video_files.find(f => f.quality === 'hd') || bestClip.video_files[0];
      if (fileLink && fileLink.link) {
        console.log('[PEXELS] Clip found:', fileLink.link);
        return fileLink.link;
      }
      console.warn('[PEXELS] No valid video file link found in bestClip');
    } else {
      console.log(`[PEXELS] No match found for: "${subject}"`);
    }
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[PEXELS] Request failed. Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[PEXELS] Request failed:', err);
    }
    return null;
  }
}

// --- PIXABAY VIDEO FALLBACK ---
async function findClipInPixabay(subject) {
  console.log(`[PIXABAY] findClipInPixabay | subject="${subject}"`);
  if (!PIXABAY_API_KEY) {
    console.warn('[PIXABAY] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/videos/?key=${PIXABAY_API_KEY}&q=${query}&per_page=5`;
    console.log(`[PIXABAY] Request: ${url}`);
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      console.log(`[PIXABAY] ${resp.data.hits.length} videos found for "${subject}"`);
      const best = resp.data.hits.sort((a, b) => (b.videos.large.width * b.videos.large.height) - (a.videos.large.width * a.videos.large.height))[0];
      if (best && best.videos && best.videos.large && best.videos.large.url) {
        console.log('[PIXABAY] Clip found:', best.videos.large.url);
        return best.videos.large.url;
      }
      console.warn('[PIXABAY] No valid large video link in best result');
    } else {
      console.log(`[PIXABAY] No match found for: "${subject}"`);
    }
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[PIXABAY] Request failed. Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[PIXABAY] Request failed:', err);
    }
    return null;
  }
}

// === STILL IMAGE FALLBACKS (PEXELS/PIXABAY) ===
async function findImageInPexels(subject) {
  console.log(`[PEXELS-IMG] Searching for still image | subject="${subject}"`);
  if (!PEXELS_API_KEY) {
    console.warn('[PEXELS-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=5`;
    console.log(`[PEXELS-IMG] Request: ${url}`);
    const resp = await axios.get(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (resp.data && resp.data.photos && resp.data.photos.length > 0) {
      const best = resp.data.photos[0];
      console.log(`[PEXELS-IMG] Found image: ${best.src.original}`);
      return best.src.original;
    }
    console.log(`[PEXELS-IMG] No images found for: "${subject}"`);
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[PEXELS-IMG] Request failed. Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[PEXELS-IMG] Request failed:', err);
    }
    return null;
  }
}

async function findImageInPixabay(subject) {
  console.log(`[PIXABAY-IMG] Searching for still image | subject="${subject}"`);
  if (!PIXABAY_API_KEY) {
    console.warn('[PIXABAY-IMG] No API key set.');
    return null;
  }
  try {
    const query = encodeURIComponent(subject);
    const url = `https://pixabay.com/api/?key=${PIXABAY_API_KEY}&q=${query}&image_type=photo&per_page=5`;
    console.log(`[PIXABAY-IMG] Request: ${url}`);
    const resp = await axios.get(url);
    if (resp.data && resp.data.hits && resp.data.hits.length > 0) {
      const best = resp.data.hits[0];
      if (best && best.largeImageURL) {
        console.log(`[PIXABAY-IMG] Found image: ${best.largeImageURL}`);
        return best.largeImageURL;
      }
    }
    console.log(`[PIXABAY-IMG] No images found for: "${subject}"`);
    return null;
  } catch (err) {
    if (err.response) {
      console.error(`[PIXABAY-IMG] Request failed. Status: ${err.response.status}, Data:`, err.response.data);
    } else {
      console.error('[PIXABAY-IMG] Request failed:', err);
    }
    return null;
  }
}

// --- Ken Burns Effect: Make Video From Image (FFmpeg) ---
async function makeKenBurnsVideoFromImage(imgPath, outPath, duration = 5) {
  // Randomize pan direction: 0 = left→right, 1 = right→left
  const direction = Math.random() > 0.5 ? 'ltr' : 'rtl';
  console.log(`[KENBURNS] Creating Ken Burns pan video (${direction}) | ${imgPath} → ${outPath} (${duration}s)`);

  // Make sure image exists
  if (!fs.existsSync(imgPath)) throw new Error('[KENBURNS] Image does not exist: ' + imgPath);

  // Video size: 1080x1920 (vertical)
  const width = 1080, height = 1920;
  // Pan effect: Move image horizontally (slow, only once)
  // - For LTR: start at x=0, end at x=(img_width - width)
  // - For RTL: start at x=(img_width - width), end at x=0
  // The FFmpeg filter will compute these values
  const filter = direction === 'ltr'
    ? `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`
    : `[0:v]scale=${width*1.4}:${height*1.4},crop=${width}:${height}:x='(iw-${width})-(iw-${width})*t/${duration}',setpts=PTS-STARTPTS[v]`;

  const ffmpegCmd = `ffmpeg -y -loop 1 -i "${imgPath}" -filter_complex "${filter}" -map "[v]" -t ${duration} -r 30 -pix_fmt yuv420p -c:v libx264 "${outPath}"`;
  console.log(`[KENBURNS] Running FFmpeg: ${ffmpegCmd}`);

  return new Promise((resolve, reject) => {
    exec(ffmpegCmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[KENBURNS] FFmpeg error:', error, stderr);
        return reject(error);
      }
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 4096) {
        return reject(new Error('[KENBURNS] Output video not created or too small'));
      }
      console.log('[KENBURNS] Ken Burns pan video created:', outPath);
      resolve(outPath);
    });
  });
}

// --- Download function: saves a remote file to disk with logging ---
async function downloadRemoteFileToLocal(url, outPath) {
  console.log(`[DL] DownloadRemoteFileToLocal called | url="${url}" | outPath="${outPath}"`);
  try {
    if (!url) throw new Error('No URL provided to download.');
    if (fs.existsSync(outPath)) {
      console.log(`[DL] File already exists, skipping download: ${outPath}`);
      return;
    }

    const writer = fs.createWriteStream(outPath);
    const resp = await axios({
      url,
      method: 'GET',
      responseType: 'stream',
      timeout: 60000
    });

    await new Promise((resolve, reject) => {
      resp.data.pipe(writer);
      let errored = false;
      writer.on('error', err => {
        errored = true;
        console.error('[DL] Stream error:', err);
        writer.close();
        reject(err);
      });
      writer.on('finish', () => {
        if (!errored) {
          console.log('[DL] Download complete:', outPath, 'size:', fs.existsSync(outPath) ? fs.statSync(outPath).size : 'N/A');
          resolve();
        }
      });
    });

    if (!fs.existsSync(outPath)) {
      throw new Error('[DL] File not written after download: ' + outPath);
    }
  } catch (err) {
    console.error('[DL] Download failed:', url, err);
    throw err;
  }
}

// --- MAIN MATCHER: R2 → PEXELS → PIXABAY → IMAGE → KenBurns ---
async function findClipForScene(sceneText, idx, allLines = [], title = '', s3Client) {
  console.log(`[MATCH] findClipForScene called | idx=${idx} | sceneText="${sceneText}" | title="${title}"`);
  if (allLines && allLines.length) console.log(`[MATCH] All lines for context:`, allLines);
  const subject = extractVisualSubject(sceneText, title || '');
  console.log(`[MATCH] Scene ${idx + 1} subject after extraction: "${subject}"`);

  // 1. Try R2 first
  if (s3Client) {
    try {
      const r2Url = await findClipInR2(subject, s3Client);
      if (typeof r2Url === 'string' && r2Url.startsWith('http')) {
        console.log(`[MATCH] Matched in R2: ${r2Url}`);
        return r2Url;
      }
    } catch (err) {
      console.error('[MATCH] Error in findClipInR2:', err);
    }
  }

  // 2. Try Pexels Video
  try {
    const pexelsUrl = await findClipInPexels(subject);
    if (typeof pexelsUrl === 'string' && pexelsUrl.startsWith('http')) {
      console.log(`[MATCH] Matched in Pexels: ${pexelsUrl}`);
      return pexelsUrl;
    }
  } catch (err) {
    console.error('[MATCH] Error in findClipInPexels:', err);
  }

  // 3. Try Pixabay Video
  try {
    const pixabayUrl = await findClipInPixabay(subject);
    if (typeof pixabayUrl === 'string' && pixabayUrl.startsWith('http')) {
      console.log(`[MATCH] Matched in Pixabay: ${pixabayUrl}`);
      return pixabayUrl;
    }
  } catch (err) {
    console.error('[MATCH] Error in findClipInPixabay:', err);
  }

  // 4. Try Pexels/Pixabay Image → Ken Burns
  let imageUrl = null;
  try {
    imageUrl = await findImageInPexels(subject);
    if (!imageUrl) {
      imageUrl = await findImageInPixabay(subject);
    }
  } catch (err) {
    console.error('[MATCH] Error finding fallback image:', err);
  }

  if (imageUrl) {
    try {
      const tmpDir = path.join(__dirname, 'tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
      const imgName = `kenburns-${uuidv4()}.jpg`;
      const imgPath = path.join(tmpDir, imgName);
      await downloadRemoteFileToLocal(imageUrl, imgPath);

      const outVidName = `kenburns-${uuidv4()}.mp4`;
      const outVidPath = path.join(tmpDir, outVidName);

      await makeKenBurnsVideoFromImage(imgPath, outVidPath, 5 + Math.floor(Math.random() * 2)); // 5–6s pan

      console.log(`[MATCH] Ken Burns fallback video created: ${outVidPath}`);
      return outVidPath;
    } catch (err) {
      console.error('[MATCH] Ken Burns fallback failed:', err);
    }
  }

  // FINAL: If nothing, just return null (should never happen with images available!)
  console.warn(`[MATCH] No match found for scene "${sceneText}" (subject="${subject}") in any source.`);
  return null;
}

// --- Script splitter: splits raw script into array of { id, text } ----
function splitScriptToScenes(script) {
  console.log(`[SPLIT] splitScriptToScenes called | script length: ${script ? script.length : 0}`);
  if (!script) {
    console.warn('[SPLIT] No script provided!');
    return [];
  }
  const arr = script
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((line, idx) => ({
      id: `scene${idx + 1}`,
      text: line
    }));
  console.log(`[SPLIT] Script split into ${arr.length} scenes`);
  return arr;
}

module.exports = {
  findClipForScene,
  splitScriptToScenes,
  downloadRemoteFileToLocal
};
