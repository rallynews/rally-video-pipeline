const { execFile } = require('child_process');

// Thin promise wrappers around the ffmpeg/ffprobe binaries. The pipeline runs
// on GitHub Actions' ubuntu-latest image, which ships both; locally, install
// them with `apt-get install ffmpeg` / `brew install ffmpeg`.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).split('\n').slice(-25).join('\n');
        reject(new Error(`${bin} failed: ${tail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ffmpeg(args, opts) {
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], opts);
}

async function ffprobeDuration(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { timeout: 60000 });
  const value = parseFloat(String(stdout).trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Could not read a duration from ${file}`);
  }
  return value;
}

async function isAvailable() {
  try {
    await run(FFMPEG, ['-version'], { timeout: 15000 });
    await run(FFPROBE, ['-version'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

module.exports = { ffmpeg, ffprobeDuration, isAvailable, FFMPEG, FFPROBE };
