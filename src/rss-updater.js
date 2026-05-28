const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const FEED_PATH = path.join(__dirname, '..', 'feed.xml');

const FEED_TITLE = 'Rally News — Featured Stories';
const FEED_LINK = 'https://rallynews.com';
const FEED_DESCRIPTION = 'The most uplifting and viral positive news stories, curated daily by Rally News.';

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildItem(story, pubDate) {
  const lines = [
    '    <item>',
    `      <title>${escapeXml(story.headline)}</title>`,
    `      <link>${escapeXml(story.url)}</link>`,
    `      <description>${escapeXml(story.summary)}</description>`,
    `      <pubDate>${pubDate}</pubDate>`,
    `      <guid isPermaLink="true">${escapeXml(story.url)}</guid>`,
  ];

  if (story.thumbnail) {
    lines.push(`      <enclosure url="${escapeXml(story.thumbnail)}" type="image/jpeg" length="0"/>`);
    lines.push(`      <media:content url="${escapeXml(story.thumbnail)}" medium="image"/>`);
  }

  lines.push('    </item>');
  return lines.join('\n');
}

function parsedItemsToXml(existingXml) {
  // Extract all existing <item>...</item> blocks from the existing feed
  const matches = existingXml.match(/<item>[\s\S]*?<\/item>/g);
  return matches || [];
}

function updateRSSFeed(story) {
  const pubDate = new Date().toUTCString();
  const newItem = buildItem(story, pubDate);

  let existingItems = [];
  if (fs.existsSync(FEED_PATH)) {
    const existing = fs.readFileSync(FEED_PATH, 'utf8');
    existingItems = parsedItemsToXml(existing);
  }

  // Prepend the new item; keep at most 50 items to prevent unbounded growth
  const items = [newItem, ...existingItems].slice(0, 50);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"',
    '  xmlns:media="http://search.yahoo.com/mrss/"',
    '  xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(FEED_TITLE)}</title>`,
    `    <link>${escapeXml(FEED_LINK)}</link>`,
    `    <description>${escapeXml(FEED_DESCRIPTION)}</description>`,
    '    <language>en-us</language>',
    `    <lastBuildDate>${pubDate}</lastBuildDate>`,
    '    <atom:link href="https://raw.githubusercontent.com/rallynews/rally-video-pipeline/main/feed.xml" rel="self" type="application/rss+xml"/>',
    '',
    items.join('\n\n'),
    '  </channel>',
    '</rss>',
  ].join('\n');

  fs.writeFileSync(FEED_PATH, xml, 'utf8');
  console.log(`   RSS feed updated — ${items.length} item(s) in feed.xml`);
}

module.exports = { updateRSSFeed };
