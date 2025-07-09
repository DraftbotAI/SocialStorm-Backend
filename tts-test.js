const textToSpeech = require('@google-cloud/text-to-speech');
const fs = require('fs');
const util = require('util');

const client = new textToSpeech.TextToSpeechClient();

async function quickTest() {
  const request = {
    input: { text: 'This is a sample of my voice.' },
    voice: { languageCode: 'en-US', ssmlGender: 'FEMALE' },
    audioConfig: { audioEncoding: 'MP3' },
  };

  const [response] = await client.synthesizeSpeech(request);
  await util.promisify(fs.writeFile)('sample.mp3', response.audioContent, 'binary');
  console.log('sample.mp3 created!');
}

quickTest().catch(console.error);
