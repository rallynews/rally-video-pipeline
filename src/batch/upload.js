const fs = require('fs');
const os = require('os');
const path = require('path');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const catalogue = require('../reels/r2-catalogue');
const ff = require('../reels/ffmpeg');
const { publicUrl } = require('./draft');

// Finished reels go into the videos bucket next to the library, one dated
// folder per day, named after the story plus its batch and slot so two videos
// of the same story on the same day never overwrite each other:
//
//   reels/<date>/<slug>-b<batch>-<slot>.mp4   (and .jpg, its poster frame)
async function uploadObject(buffer, key, contentType) {
  await catalogue.getClient().send(new PutObjectCommand({
    Bucket: catalogue.VIDEO_BUCKET(),
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  console.log(`  [r2] uploaded ${key}`);
  return publicUrl(key);
}

// A still for Studio's player and Joyscroll's card: a frame just past the
// opening, where the article photo and the headline are both on screen.
async function posterFrame(mp4Buffer) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rally-poster-'));
  try {
    const src = path.join(dir, 'reel.mp4');
    const out = path.join(dir, 'poster.jpg');
    fs.writeFileSync(src, mp4Buffer);
    await ff.ffmpeg(['-ss', '1.2', '-i', src, '-frames:v', '1', '-q:v', '3', '-y', out]);
    return fs.existsSync(out) ? fs.readFileSync(out) : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { uploadObject, posterFrame };
