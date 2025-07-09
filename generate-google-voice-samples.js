const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const util = require('util');

const client = new textToSpeech.TextToSpeechClient();

const SAMPLE_TEXT = "This is a sample of my voice.";

// List voices you want (grab these from Google Cloud voice list or use the script below to list them)
const voices = [
  { name: "en-US-Standard-A", languageCode: "en-US" },
  { name: "en-US-Standard-B", languageCode: "en-US" },
  { name: "en-US-Standard-C", languageCode: "en-US" },
  { name: "en-US-Standard-D", languageCode: "en-US" },
  { name: "en-US-Wavenet-A", languageCode: "en-US" },
  { name: "en-US-Wavenet-B", languageCode: "en-US" },
  { name: "en-US-Wavenet-C", languageCode: "en-US" },
  { name: "en-US-Wavenet-D", languageCode: "en-US" },
  // Add more voices as needed
];

async function generateSample(voice) {
  const request = {
    input: { text: SAMPLE_TEXT },
    voice: { languageCode: voice.languageCode, name: voice.name },
    audioConfig: { audioEncoding: 'MP3' },
  };

  const [response] = await client.synthesizeSpeech(request);
  const fileName = `sample_${voice.name}.mp3`;
  await util.promisify(fs.writeFile)(fileName, response.audioContent, 'binary');
  console.log(`Generated sample: ${fileName}`);
}

async function run() {
  for (const v of voices) {
    await generateSample(v);
  }
}

run();
