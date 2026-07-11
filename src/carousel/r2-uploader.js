const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Cloudflare R2 is S3-compatible. Required env:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//   R2_BUCKET, R2_PUBLIC_URL (public bucket URL or custom domain)
function getClient() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error('Missing R2 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

function publicUrl(key) {
  const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return `${base}/${key}`;
}

// Upload the 5 slide PNGs under a per-run folder. Returns their public URLs.
async function uploadCarousel(images, slug) {
  const bucket = process.env.R2_BUCKET;
  if (!bucket) throw new Error('Missing R2_BUCKET');

  const client = getClient();
  const stamp = new Date().toISOString().slice(0, 10);
  const folder = `carousels/${stamp}/${slug}`;
  const urls = [];

  for (let i = 0; i < images.length; i++) {
    const key = `${folder}/slide-${i + 1}.png`;
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: images[i],
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    urls.push(publicUrl(key));
    console.log(`  [r2] uploaded ${key}`);
  }

  return urls;
}

module.exports = { uploadCarousel };
