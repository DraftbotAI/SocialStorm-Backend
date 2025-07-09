const fs = require('fs');
const path = require('path');
const textToSpeech = require('@google-cloud/text-to-speech');

// You may need to set GOOGLE_APPLICATION_CREDENTIALS env variable or pass keyFilename.
const client = new textToSpeech.TextToSpeechClient({
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});

// List of Google TTS voices you want samples for:
const voices = [
  "en-US-Neural2-F",
  "en-US-Studio-O",
  "en-US-Neural2-G",
  "en-US-Studio-Q",
  "en-US-Wavenet-F",
  "en-US-Wavenet-H",
  "en-US-Neural2-D",
  "en-US-Studio-M",
  "en-US-Neural2-J",
  "en-US-Studio-B",
  "en-US-Wavenet-B",
  "en-US-Wavenet-D"
];

const sampleText = "This is a sample of my voice.";
const destFolder = path.join(__dirname, 'frontend', 'voice-previews');

if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

(async () => {
  for (const voice of voices) {
    const request = {
      input: { text: sampleText },
      voice: { languageCode: "en-US", name: voice },
      audioConfig: { audioEncoding: "MP3" }
    };
    const [response] = await client.synthesizeSpeech(request);
    const outPath = path.join(destFolder, `sample_${voice}.mp3`);
    fs.writeFileSync(outPath, response.audioContent, 'binary');
    console.log(`Saved: ${outPath}`);
  }
  console.log("✅ All samples generated!");
})();
