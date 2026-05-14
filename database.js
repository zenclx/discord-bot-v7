const fs = require('fs');
const path = require('path');

const FALLBACK_DB_PATH = path.join(__dirname, 'data.json');
const PRIMARY_DB_PATH = process.env.DATA_PATH || FALLBACK_DB_PATH;
let activeDbPath = PRIMARY_DB_PATH;

function defaults() {
  return { scoreboards: {}, matches: {}, settings: {} };
}

function ensureWritable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function switchToFallback(error) {
  if (activeDbPath === FALLBACK_DB_PATH) throw error;
  console.warn(`Primary data path unavailable (${activeDbPath}): ${error.message}. Falling back to ${FALLBACK_DB_PATH}`);
  activeDbPath = FALLBACK_DB_PATH;
}

function load() {
  try {
    if (!fs.existsSync(activeDbPath)) {
      const data = defaults();
      ensureWritable(activeDbPath);
      fs.writeFileSync(activeDbPath, JSON.stringify(data, null, 2));
      return data;
    }
    return JSON.parse(fs.readFileSync(activeDbPath, 'utf8'));
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOENT') {
      switchToFallback(e);
      return load();
    }
    console.error('Failed to load data file:', e.message);
    return defaults();
  }
}

function save(data) {
  try {
    ensureWritable(activeDbPath);
    fs.writeFileSync(activeDbPath, JSON.stringify(data, null, 2));
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOENT') {
      switchToFallback(e);
      save(data);
      return;
    }
    throw e;
  }
}

function get() {
  return load();
}

function set(data) {
  save(data);
}

module.exports = { get, set };
