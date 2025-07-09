// ===== 1) ENV & DEPENDENCIES =====
require('dotenv').config();
const axios = require('axios');
const stringSimilarity = require('string-similarity');

// ===== 2) STOP WORDS FOR QUERY CLEANUP =====
const STOP_WORDS = new Set([
  'and','the','with','into','for','a','to','of','in','on','at','by','from'
]);
function sanitizeQuery(raw, maxWords = 10) {
  return raw
    .replace(/["“”‘’.,!?;:]/g, '')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, maxWords)
    .join(' ');
}

// ===== 3) URL NORMALIZER =====
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

// ===== 4) SHUFFLE ARRAY =====
function shuffleArray(arr) {
  for (let i = arr.length -1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ===== 5) GPT-POWERED KEYWORD EXTRACTOR =====
async function getSearchKeywords(line) {
  // Hard timeout: 7 seconds
  const promise = (async () => {
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const resp = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: "Extract 2-5 extremely specific keywords for stock video/image search, focusing on the **most visual subject** of the sentence. Output a comma-separated list. NO sentences, no hashtags." },
          { role: 'user', content: line }
        ],
        temperature: 0.1
      });
      let text = resp.choices[0].message.content.trim();
      return text.replace(/\.$/, '');
    } catch (err) {
      return sanitizeQuery(line, 5);
    }
  })();
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(sanitizeQuery(line, 5)), 7000))
  ]);
}

// ===== 6) PIXABAY PHOTO FALLBACK =====
async function searchPixabayPhoto(query, keywords = [], mainSubject = '', excludeUrls = []) {
  const url = 'https://pixabay.com/api/';
  const params = {
    key: process.env.PIXABAY_API_KEY,
    q: query,
    safesearch: true,
    per_page: 20,
    lang: 'en',
    image_type: 'photo'
  };
  try {
    const resp = await axios.get(url, { params, timeout: 6000 });
    if (resp.data && Array.isArray(resp.data.hits) && resp.data.hits.length > 0) {
      let filtered = resp.data.hits.filter(img => {
        const meta = `${img.tags} ${img.user}`.toLowerCase();
        const imgUrl = normalizeUrl(img.largeImageURL);
        return mainSubject && meta.includes(mainSubject.toLowerCase()) && !excludeUrls.includes(imgUrl);
      });
      if (filtered.length === 0) {
        filtered = resp.data.hits.filter(img => {
          const imgUrl = normalizeUrl(img.largeImageURL);
          return !excludeUrls.includes(imgUrl);
        });
      }
      if (filtered.length > 0) {
        filtered = shuffleArray(filtered);
        const best = filtered[0];
        if (best && best.largeImageURL) {
          return {
            type: 'photo',
            url: best.largeImageURL,
            score: 0.7,
            isKenBurns: true,
            source: 'pixabay',
            credit: 'Pixabay'
          };
        }
      }
    }
    return null;
  } catch (err) {
    console.error('[Pixabay PHOTO ERROR]', err.message);
    return null;
  }
}

// ===== 7) PROMISE TIMEOUT WRAPPER =====
function promiseTimeout(promise, ms, msg = "Timed out") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ]);
}

// ===== 8) MOTIVATIONAL DETECTOR =====
function isMotivationalQuery(text, mainSubject = '') {
  const MOTIVATIONAL_WORDS = [
    'motivation','motivational','inspiration','inspiring','affirmation','affirmations',
    'inspire','confidence','success','achieve','goal','goals','positive','self love','self improvement','overcome','gratitude','believe','focus','power','dream','dreams'
  ];
  const lc = text.toLowerCase() + ' ' + (mainSubject || '').toLowerCase();
  return MOTIVATIONAL_WORDS.some(w => lc.includes(w));
}

// ===== 9) MAIN CLIP PICKER =====
async function pickClipFor(rawQuery, tempDir = './tmp', minScore = 0.13, mainSubject = '', excludeUrls = []) {
  if (!rawQuery) throw new Error('pickClipFor: query is required');
  if (!mainSubject) throw new Error('pickClipFor: mainSubject is required');
  excludeUrls = excludeUrls.map(u => normalizeUrl(u));

  // Step 1: Extract keywords (with timeout)
  let keywordsRaw = await getSearchKeywords(rawQuery);
  let keywordsArr = keywordsRaw
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  let mainQuery = `${mainSubject} ${keywordsArr.join(' ')}`.trim();

  // Search specificity: most-specific → least-specific
  let searchVariants = [
    mainQuery,
    ...(keywordsArr.length >= 1 ? keywordsArr.map(kw => `${mainSubject} ${kw}`) : []),
    mainSubject
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  // ===== A) SPECIAL LOGIC FOR MOTIVATIONAL/INSPIRATIONAL/AFFIRMATION =====
  if (isMotivationalQuery(rawQuery, mainSubject)) {
    const motivationalThemes = [
      "inspiring people", "crowd cheering", "audience clapping", "mountain sunrise", "running on beach",
      "reaching summit", "woman smiling confidence", "nature sunrise", "happy people outdoors", "achievement", "success", "celebrating goal",
      "city sunrise", "hiker sunrise", "triumph", "overcome obstacle", "winning", "motivational", "determined", "hope", "dream", "gratitude"
    ];
    const randomThemes = shuffleArray([...motivationalThemes]);
    for (const theme of randomThemes) {
      try {
        const resp = await promiseTimeout(
          axios.get('https://api.pexels.com/videos/search', {
            headers: { Authorization: process.env.PEXELS_API_KEY },
            params: { query: theme, per_page: 10 },
            timeout: 6000
          }),
          7000,
          "Pexels video search timed out"
        );
        const vids = resp.data.videos || [];
        if (vids.length) {
          const verticalVids = vids.filter(v =>
            (v.video_files || []).some(f => f.height / f.width > 0.98)
          );
          const picks = verticalVids.length ? verticalVids : vids;
          shuffleArray(picks);
          const top = picks[0];
          const vf = (top.video_files || []).find(f => f.height / f.width > 0.98 && f.width <= 800)
            || (top.video_files || [])[0];
          if (vf && vf.link) {
            return {
              type: 'video',
              url: vf.link,
              score: 1,
              isKenBurns: false,
              source: 'pexels'
            };
          }
        }
      } catch (err) {
        continue;
      }
    }
    // Try photos if no video found
    for (const theme of randomThemes) {
      try {
        const resp = await promiseTimeout(
          axios.get('https://api.pexels.com/v1/search', {
            headers: { Authorization: process.env.PEXELS_API_KEY },
            params: { query: theme, per_page: 10 },
            timeout: 6000
          }),
          7000,
          "Pexels photo search timed out"
        );
        const pics = resp.data.photos || [];
        if (pics.length) {
          shuffleArray(pics);
          const best = pics[0];
          if (best && best.src && best.src.large) {
            return {
              type: 'photo',
              url: best.src.large,
              score: 1,
              isKenBurns: true,
              source: 'pexels'
            };
          }
        }
      } catch (err) {
        continue;
      }
    }
  }

  // ===== B) PEXELS VIDEO =====
  for (const query of searchVariants) {
    try {
      const resp = await promiseTimeout(
        axios.get('https://api.pexels.com/videos/search', {
          headers: { Authorization: process.env.PEXELS_API_KEY },
          params: { query, per_page: 12 },
          timeout: 6000
        }),
        7000,
        "Pexels video search timed out"
      );
      const vids = resp.data.videos || [];
      if (vids.length) {
        let choices = vids
          .map(v => {
            const meta = [
              v.url,
              v.user?.name || '',
              Array.isArray(v.tags) ? v.tags.join(' ') : '',
              v.description || ''
            ].join(' ');
            // Vertical-ness boost: prefer vertical
            const vf = (v.video_files || []).find(f => f.height / f.width > 1.1 && f.width <= 800);
            const fileToUse = vf || (v.video_files || []).reduce((max, f) => f.width > max.width ? f : max, v.video_files[0]);
            const scoreBase = stringSimilarity.compareTwoStrings(meta.toLowerCase(), rawQuery.toLowerCase());
            const score = scoreBase + (vf ? 0.25 : 0);
            return {
              ...v,
              score,
              bestFile: fileToUse,
              normUrl: normalizeUrl(fileToUse.link || '')
            };
          })
          .filter(v => v.bestFile && v.bestFile.link && !excludeUrls.includes(v.normUrl));
        // Sort: high score, vertical, width
        choices.sort((a, b) =>
          b.score - a.score ||
          (b.bestFile.height / b.bestFile.width > 1 ? 1 : -1) - (a.bestFile.height / a.bestFile.width > 1 ? 1 : -1) ||
          (b.bestFile.width - a.bestFile.width)
        );
        // Only accept vertical or square for Shorts!
        const top = choices.find(c => c.bestFile.height / c.bestFile.width >= 0.98) || choices[0];
        if (top && top.score >= minScore) {
          return {
            type: 'video',
            url: top.bestFile.link,
            score: top.score,
            isKenBurns: false,
            source: 'pexels'
          };
        }
      }
    } catch (err) {
      console.error('[Pexels VIDEO ERROR]', err.message);
      continue;
    }
  }

  // ===== C) PEXELS PHOTO =====
  for (const query of searchVariants) {
    try {
      const resp = await promiseTimeout(
        axios.get('https://api.pexels.com/v1/search', {
          headers: { Authorization: process.env.PEXELS_API_KEY },
          params: { query, per_page: 12 },
          timeout: 6000
        }),
        7000,
        "Pexels photo search timed out"
      );
      const pics = resp.data.photos || [];
      if (pics.length) {
        const scored = pics
          .map(p => {
            const meta = [
              p.alt || '',
              p.photographer || '',
              (p.tags ? p.tags.join(' ') : '')
            ].join('');
            const score = stringSimilarity.compareTwoStrings(meta.toLowerCase(), rawQuery.toLowerCase());
            const picUrl = normalizeUrl(p.src?.large || '');
            return { ...p, score, picUrl };
          })
          .filter(p => p.picUrl && !excludeUrls.includes(p.picUrl));
        scored.sort((a, b) => b.score - a.score || 0);
        if (scored.length) {
          const best = scored[0];
          return {
            type: 'photo',
            url: best.src.large,
            score: best.score,
            isKenBurns: true,
            source: 'pexels'
          };
        }
      }
    } catch (err) {
      console.error('[Pexels PHOTO ERROR]', err.message);
      continue;
    }
  }

  // ===== D) PIXABAY VIDEO =====
  for (const query of searchVariants) {
    const url = 'https://pixabay.com/api/videos/';
    const params = {
      key: process.env.PIXABAY_API_KEY,
      q: query,
      safesearch: true,
      per_page: 12,
      lang: 'en',
      video_type: 'all'
    };
    try {
      const resp = await promiseTimeout(
        axios.get(url, { params, timeout: 6000 }),
        7000,
        "Pixabay video search timed out"
      );
      if (resp.data && Array.isArray(resp.data.hits) && resp.data.hits.length > 0) {
        const scored = resp.data.hits
          .map(vid => {
            const meta = `${vid.tags} ${vid.user}`.toLowerCase();
            const videoUrl =
              (vid.videos.large && vid.videos.large.url) ||
              (vid.videos.medium && vid.videos.medium.url) ||
              (vid.videos.tiny && vid.videos.tiny.url) || '';
            // Prefer vertical
            const isVertical = vid.videos.large && vid.videos.large.height / vid.videos.large.width > 1.05;
            const scoreBase = stringSimilarity.compareTwoStrings(meta, rawQuery.toLowerCase());
            const score = scoreBase + (isVertical ? 0.2 : 0);
            return { ...vid, score, videoUrl, normUrl: normalizeUrl(videoUrl) };
          })
          .filter(v => v.videoUrl && !excludeUrls.includes(v.normUrl));
        // Prefer vertical, then best score
        scored.sort((a, b) =>
          b.score - a.score ||
          ((b.videos.large?.height / b.videos.large?.width) - (a.videos.large?.height / a.videos.large?.width)) ||
          0
        );
        const top = scored.find(c => c.videos.large?.height / c.videos.large?.width > 0.98) || scored[0];
        if (top) {
          return {
            type: 'video',
            url: top.videoUrl,
            score: top.score,
            isKenBurns: false,
            source: 'pixabay'
          };
        }
      }
    } catch (err) {
      console.error('[Pixabay VIDEO ERROR]', err.message);
      continue;
    }
  }

  // ===== E) PIXABAY PHOTO =====
  const photoResults = await Promise.all(
    searchVariants.map(q =>
      promiseTimeout(searchPixabayPhoto(q, keywordsArr, mainSubject, excludeUrls), 7000, "Pixabay photo search timed out")
    )
  );
  const pixabayPic = photoResults.find(r => r && r.url);
  if (pixabayPic) {
    return pixabayPic;
  }

  // ===== F) Last Resort: Only use mainSubject photo for Ken Burns effect
  const pixabayFallback = await promiseTimeout(
    searchPixabayPhoto(mainSubject, keywordsArr, mainSubject, excludeUrls),
    7000,
    "Pixabay fallback photo search timed out"
  );
  if (pixabayFallback) {
    return pixabayFallback;
  }

  // ===== G) TOTAL FAIL-SAFE =====
  // If *everything* fails, return null to let the server generate a fallback color/black video.
  return null;
}

// ===== 10) EXPORT =====
module.exports = { pickClipFor };
