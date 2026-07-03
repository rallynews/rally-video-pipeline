// Backgrounds the character can be filmed in. The script generator picks the
// key that best matches the story's content (a movie story → theater, a plant
// growth story → forest, etc). The video generator turns the key into a rich
// scene description for the prompt.
const BACKGROUNDS = {
  office: 'in a modern open-plan office with desks and glass walls softly blurred behind them',
  airport: 'in a bright airport terminal with large windows and planes visible on the tarmac behind them',
  theater: 'inside a movie theater with rows of plush red seats and a glowing screen behind them',
  boat: 'on the open deck of a boat with sparkling water and the horizon behind them',
  airplane: 'seated in an airplane cabin with the small oval window and seat rows behind them',
  forest: 'in a lush green forest surrounded by tall trees and dappled sunlight',
  swimming_pool: 'beside a swimming pool with shimmering turquoise water behind them',
  lab: 'in a science lab with equipment, beakers and monitors softly blurred behind them',
  museum: 'in a museum gallery with framed artwork and sculptures on display behind them',
  restaurant: 'at a table in a cozy restaurant with warm ambient lighting behind them',
  bar: 'sitting at a stylish bar with shelves of backlit bottles glowing behind them',
  garden: 'in a blooming garden surrounded by colorful flowers and greenery',
  mall: 'in a bright shopping mall with storefronts and shoppers softly blurred behind them',
  salon_waiting_room: 'in a chic salon waiting room with soft lighting, plants and modern decor behind them',
};

const BACKGROUND_KEYS = Object.keys(BACKGROUNDS);

// Resolve a key to a scene description, falling back to a random background if
// the requested key isn't recognised.
function describeBackground(key) {
  if (key && BACKGROUNDS[key]) return BACKGROUNDS[key];
  const randomKey = BACKGROUND_KEYS[Math.floor(Math.random() * BACKGROUND_KEYS.length)];
  return BACKGROUNDS[randomKey];
}

module.exports = { BACKGROUNDS, BACKGROUND_KEYS, describeBackground };
