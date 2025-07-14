// test-thumbnail.js - standalone CommonJS script to test thumbnail generator locally

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { createCanvas, loadImage, registerFont } = require('canvas');
const JSZip = require('jszip');

async function generateThumbnails(topic, caption) {
  if (!topic || topic.length < 2) {
    throw new Error("Topic required.");
  }

  // 1. REGISTER ALL FONTS (from your fonts folder)
  const fontDir = path.join(__dirname, 'fonts');
  const fonts = [
    { file: 'Anton-Regular.ttf', family: 'Anton' },
    { file: 'ArchivoBlack-Regular.ttf', family: 'Archivo Black' },
    { file: 'Bangers-Regular.ttf', family: 'Bangers' },
    { file: 'BebasNeue-Regular.ttf', family: 'Bebas Neue' },
    { file: 'LuckiestGuy-Regular.ttf', family: 'Luckiest Guy' },
    { file: 'Oswald-Bold.ttf', family: 'Oswald Bold' },
    { file: 'Oswald-ExtraLight.ttf', family: 'Oswald ExtraLight' },
    { file: 'Oswald-Light.ttf', family: 'Oswald Light' },
    { file: 'Oswald-Medium.ttf', family: 'Oswald Medium' },
    { file: 'Oswald-Regular.ttf', family: 'Oswald' },
    { file: 'Oswald-SemiBold.ttf', family: 'Oswald SemiBold' },
    { file: 'Oswald-VariableFont_wght.ttf', family: 'Oswald VF' },
    { file: 'Rubik-Black.ttf', family: 'Rubik Black' },
    { file: 'Rubik-BlackItalic.ttf', family: 'Rubik Black Italic' },
    { file: 'Rubik-Bold.ttf', family: 'Rubik Bold' },
    { file: 'Rubik-BoldItalic.ttf', family: 'Rubik Bold Italic' },
    { file: 'Rubik-ExtraBold.ttf', family: 'Rubik ExtraBold' },
    { file: 'Rubik-ExtraBoldItalic.ttf', family: 'Rubik ExtraBold Italic' },
    { file: 'Rubik-Italic.ttf', family: 'Rubik Italic' },
    { file: 'Rubik-Italic-VariableFont_wght.ttf', family: 'Rubik Italic VF' },
    { file: 'Rubik-Light.ttf', family: 'Rubik Light' },
    { file: 'Rubik-LightItalic.ttf', family: 'Rubik Light Italic' },
    { file: 'Rubik-Medium.ttf', family: 'Rubik Medium' },
    { file: 'Rubik-MediumItalic.ttf', family: 'Rubik Medium Italic' },
    { file: 'Rubik-Regular.ttf', family: 'Rubik' },
    { file: 'Rubik-SemiBold.ttf', family: 'Rubik SemiBold' },
    { file: 'Rubik-SemiBoldItalic.ttf', family: 'Rubik SemiBold Italic' },
    { file: 'Rubik-VariableFont_wght.ttf', family: 'Rubik VF' },
    { file: 'Ultra-Regular.ttf', family: 'Ultra' }
  ];

  fonts.forEach(f => {
    try {
      registerFont(path.join(fontDir, f.file), { family: f.family });
    } catch (err) {
      console.log(`Skipped font ${f.file} due to error: ${err.message}`);
    }
  });

  const fontFamilies = fonts.map(f => f.family);

  const canvasWidth = 1280;
  const canvasHeight = 720;
  const previews = [];
  const zip = new JSZip();

  // 2. Viral captions (cut short here, you can add your full list)
  const captions = caption ? [caption] : [
    "You Won't Believe This!", "Top Secrets Revealed", "Watch Before It's Gone",
    "How To Change Your Life", "Shocking Truths Uncovered", "Must See Facts",
    "The Ultimate Guide", "Hidden Details Exposed", "Unlock The Mystery",
    "This Changed Everything",
    "So Easy Anyone Can Do It"
  ];

  // 3. Get Pexels image
  let pexelsImageUrl = null;
  try {
    const resp = await axios.get('https://api.pexels.com/v1/search', {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query: topic, per_page: 16 },
      timeout: 8000
    });
    const imgs = (resp.data && resp.data.photos) ? resp.data.photos : [];
    if (imgs.length > 0) {
      imgs.sort((a, b) => {
        const scoreA = (a.width * a.height) + (a.avg_color ? colorScore(a.avg_color) * 50000 : 0);
        const scoreB = (b.width * b.height) + (b.avg_color ? colorScore(b.avg_color) * 50000 : 0);
        return scoreB - scoreA;
      });
      pexelsImageUrl = imgs[0].src && imgs[0].src.large2x ? imgs[0].src.large2x : imgs[0].src.large;
    }
  } catch (err) {
    console.error("Pexels API error:", err.message);
    pexelsImageUrl = null;
  }

  function colorScore(hex) {
    if (!hex || typeof hex !== 'string') return 0;
    let r = 0, g = 0, b = 0;
    if (hex.startsWith('#') && hex.length === 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const brightness = (r + g + b) / 3;
    const vividness = (max - min);
    return brightness * 0.7 + vividness * 1.2;
  }

  // 4. Generate thumbnails
  for (let i = 0; i < captions.length; i++) {
    const text = captions[i];
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');

    if (pexelsImageUrl) {
      try {
        const img = await loadImage(pexelsImageUrl);
        const ratio = Math.max(canvasWidth / img.width, canvasHeight / img.height);
        const newW = img.width * ratio;
        const newH = img.height * ratio;
        ctx.drawImage(img, (canvasWidth - newW) / 2, (canvasHeight - newH) / 2, newW, newH);
      } catch (err) {
        ctx.fillStyle = '#222';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }
    } else {
      ctx.fillStyle = '#222';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    }

    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const fontFamily = fontFamilies[Math.floor(Math.random() * fontFamilies.length)];
    ctx.font = `bold 100px "${fontFamily}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = "round";

    ctx.lineWidth = 13;
    ctx.strokeStyle = '#000';
    ctx.strokeText(text, canvasWidth / 2, canvasHeight / 2);
    ctx.fillStyle = '#ffd700';
    ctx.fillText(text, canvasWidth / 2, canvasHeight / 2);

    ctx.lineWidth = 4;
    ctx.strokeStyle = '#fff';
    ctx.strokeText(text, canvasWidth / 2, canvasHeight / 2);

    ctx.font = 'bold 48px "Bebas Neue", "Anton", "Oswald", "Rubik", "Archivo Black", sans-serif';
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = "#00e0fe";
    ctx.fillText("SocialStorm AI", canvasWidth - 270, canvasHeight - 54);
    ctx.globalAlpha = 1.0;

    const buffer = canvas.toBuffer('image/png');
    const fileName = `thumbnail-${i + 1}.png`;
    zip.file(fileName, buffer);

    previews.push({
      fileName,
      dataUrl: 'data:image/png;base64,' + buffer.toString('base64')
    });
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.promises.writeFile('thumbnails.zip', zipBuf);

  console.log('Saved thumbnails.zip with', captions.length, 'images');

  return previews;
}

// Run test
generateThumbnails("cool corvette")
  .then(() => console.log('Thumbnail test generation completed'))
  .catch(err => console.error('Error:', err));
