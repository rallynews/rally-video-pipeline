// The keyword bank — the controlled vocabulary for reel b-roll.
//
// This list is the contract between the image library and the shot planner.
// Images are named after these words, and the planner is only allowed to ask
// for these words, so a requested shot can never fail to resolve to a file.
//
// Naming: one photo per keyword, sitting flat in the images folder, named
// after the keyword and nothing else:
//
//   forest.jpg
//   volunteers.jpg
//   river.jpg
//
// Anything in a filename that isn't in this bank is ignored for matching (the
// catalogue logs it, so typos surface on the next run). Images that fit no
// keyword go in the generic folder instead and are used as the fallback.
//
// The groups are load-bearing, not just documentation. Because the library is
// one-to-one, a keyword can only be spent once per reel — when the planner
// asks for a keyword whose photo is already on screen, the picker reaches for
// an unused photo from the SAME group before it falls back to generic, so the
// substitute is still on-theme. They also make it obvious which pillars are
// thin when you're sourcing photos.

const KEYWORD_BANK = {
  'Climate & nature': [
    'forest', 'trees', 'river', 'ocean', 'waves', 'coastline', 'mountains',
    'glacier', 'wetlands', 'meadow', 'wildflowers', 'sunrise', 'sunset',
    'rain', 'clouds', 'snow', 'waterfall', 'lake', 'farmland', 'soil',
    'seedling', 'roots', 'canopy', 'moss', 'drought', 'flood',
  ],

  'Wildlife & animals': [
    'birds', 'whale', 'dolphin', 'turtle', 'bees', 'butterfly', 'elephant',
    'wolf', 'deer', 'fish', 'penguin', 'owl', 'frog', 'seal', 'coral', 'nest',
    'dog', 'cat', 'horse', 'cattle', 'sheep', 'sanctuary',
  ],

  'Clean energy & industry': [
    'solar', 'panels', 'turbines', 'windfarm', 'battery', 'powerlines',
    'engineer', 'workshop', 'recycling', 'plastic', 'waste', 'railway',
    'cycling', 'bus', 'charging', 'factory', 'pipeline', 'toolbox',
  ],

  'Science & health': [
    'laboratory', 'microscope', 'scientist', 'research', 'dna', 'vaccine',
    'syringe', 'medicine', 'hospital', 'doctor', 'nurse', 'patient',
    'surgery', 'wheelchair', 'ambulance', 'brainscan', 'telescope',
    'satellite', 'space', 'rocket', 'robot', 'circuit', 'prosthetic',
  ],

  'Community & kindness': [
    'volunteers', 'neighbours', 'crowd', 'hands', 'handshake', 'hug',
    'family', 'grandmother', 'grandfather', 'children', 'teenagers',
    'students', 'classroom', 'teacher', 'library', 'playground', 'market',
    'cafe', 'kitchen', 'cooking', 'meal', 'foodbank', 'donation', 'shelter',
    'rescue', 'blanket',
  ],

  'Places & cities': [
    'city', 'skyline', 'street', 'rooftop', 'houses', 'village', 'town',
    'bridge', 'park', 'garden', 'allotment', 'construction', 'crane',
    'mural', 'church', 'museum', 'stadium', 'harbour',
  ],

  'Democracy & justice': [
    'voting', 'ballot', 'protest', 'march', 'banner', 'flag', 'parliament',
    'courthouse', 'gavel', 'petition', 'signature', 'microphone', 'townhall',
    'newspaper', 'journalist', 'campaign',
  ],

  'Peace & aid': [
    'peace', 'doves', 'candles', 'vigil', 'refugees', 'tent', 'aid',
    'convoy', 'border', 'reunion', 'olivebranch', 'wreath',
  ],

  'People & emotion': [
    'smiling', 'laughing', 'cheering', 'celebration', 'applause', 'tears',
    'relief', 'embrace', 'thoughtful', 'portrait', 'walking', 'running',
    'dancing', 'music', 'guitar', 'art', 'painting', 'writing', 'notebook',
    'letter', 'laptop', 'teamwork', 'meeting',
  ],

  'Achievement': [
    'medal', 'trophy', 'finishline', 'team', 'training', 'swimming',
    'football', 'climbing', 'victory', 'summit',
  ],

  'Light & texture (cutaways)': [
    'light', 'sunbeam', 'shadow', 'silhouette', 'horizon', 'road', 'path',
    'stairs', 'door', 'window', 'clock', 'calendar', 'map', 'globe',
    'water', 'ripple', 'dust', 'wind',
  ],
};

const ALL_KEYWORDS = Object.values(KEYWORD_BANK).flat();
const KEYWORD_SET = new Set(ALL_KEYWORDS);

function isKeyword(word) {
  return KEYWORD_SET.has(String(word || '').toLowerCase().trim());
}

// Keep only words that are actually in the bank.
function filterToBank(words) {
  return [...new Set(
    (Array.isArray(words) ? words : [])
      .map(w => String(w || '').toLowerCase().trim())
      .filter(w => KEYWORD_SET.has(w))
  )];
}

// The bank as the planner sees it, grouped so related words read together.
function bankPrompt() {
  return Object.entries(KEYWORD_BANK)
    .map(([group, words]) => `${group}: ${words.join(', ')}`)
    .join('\n');
}

const GROUP_OF = new Map();
for (const [group, words] of Object.entries(KEYWORD_BANK)) {
  for (const word of words) GROUP_OF.set(word, group);
}

function groupOf(keyword) {
  return GROUP_OF.get(String(keyword || '').toLowerCase().trim()) || null;
}

// Every other keyword sharing a theme group with the ones given — the pool the
// picker reaches into when the exact photo is already spent.
function siblingsOf(keywords) {
  const wanted = new Set(filterToBank(keywords));
  const groups = new Set([...wanted].map(groupOf).filter(Boolean));
  const out = [];
  for (const group of groups) {
    for (const word of KEYWORD_BANK[group]) {
      if (!wanted.has(word)) out.push(word);
    }
  }
  return out;
}

module.exports = {
  KEYWORD_BANK, ALL_KEYWORDS, KEYWORD_SET,
  isKeyword, filterToBank, bankPrompt, groupOf, siblingsOf,
};
