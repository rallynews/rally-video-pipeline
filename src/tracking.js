// UTM tags on every link the pipeline hands out, so Google Analytics on
// rally.news can tell which post, platform and reel a visit came from.
//
//   utm_source    facebook | instagram | rss
//   utm_medium    social | rss
//   utm_campaign  carousel (Studio batches) | daily-video (the talking-head run)
//   utm_content   b<batch>-v<slot> — one reel, so each video's traffic is its own row
//
// In GA4: Reports → Acquisition → Traffic acquisition, with "Session source /
// medium" and "Session manual ad content" (utm_content) as dimensions.
//
// The tags are appended to the end of the URL as text rather than rebuilt
// through URLSearchParams, so the story's own ?article=…&id=… is left exactly
// as Rally wrote it. Any utm_ already on the link is replaced. rally.news keeps
// these on the page for analytics and drops them from its canonical URL, so
// they never affect search.

function tagUrl(url, tags) {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw;
  const [beforeHash, hash] = raw.split('#');
  const [base, query = ''] = beforeHash.split('?');
  const kept = query.split('&').filter(p => p && !/^utm_[a-z]+=/i.test(p));
  for (const [k, v] of Object.entries(tags)) {
    if (v) kept.push(`utm_${k}=${encodeURIComponent(String(v))}`);
  }
  return base + (kept.length ? `?${kept.join('&')}` : '') + (hash !== undefined ? `#${hash}` : '');
}

// The two links a Carousel reel's posts carry: Facebook's first comment and
// the Instagram link in bio.
function captionLinks(storyUrl, batch, slot) {
  const common = { medium: 'social', campaign: 'carousel', content: batch && slot ? `b${batch}-v${slot}` : '' };
  return {
    facebook: tagUrl(storyUrl, { source: 'facebook', ...common }),
    instagram: tagUrl(storyUrl, { source: 'instagram', ...common }),
  };
}

function feedLink(storyUrl, campaign, content) {
  return tagUrl(storyUrl, { source: 'rss', medium: 'rss', campaign, content });
}

module.exports = { tagUrl, captionLinks, feedLink };
