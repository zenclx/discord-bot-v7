const fs = require('fs');
const path = require('path');

const FALLBACK_DB_PATH = path.join(__dirname, 'data.json');
const PRIMARY_DB_PATH = process.env.DATA_PATH || FALLBACK_DB_PATH;
let activeDbPath = PRIMARY_DB_PATH;
let memoryData = null;
const listeners = new Set();

function defaults() {
  return { scoreboards: {}, matches: {}, settings: {} };
}

function ensureWritable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function switchToFallback(error) {
  if (activeDbPath === FALLBACK_DB_PATH) throw error;
  console.warn(`Primary data path unavailable (${activeDbPath}): ${error.message}. Falling back to ${FALLBACK_DB_PATH}`);
  activeDbPath = FALLBACK_DB_PATH;
}

function load() {
  if (memoryData) return clone(memoryData);

  try {
    if (!fs.existsSync(activeDbPath)) {
      const data = defaults();
      ensureWritable(activeDbPath);
      atomicWrite(activeDbPath, data);
      memoryData = data;
      return clone(memoryData);
    }
    memoryData = JSON.parse(fs.readFileSync(activeDbPath, 'utf8'));
    return clone(memoryData);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOENT') {
      switchToFallback(e);
      return load();
    }
    console.error('Failed to load data file:', e.message);
    memoryData = memoryData || defaults();
    return clone(memoryData);
  }
}

function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function save(data, { notify = true } = {}) {
  memoryData = clone(data);

  try {
    ensureWritable(activeDbPath);
    atomicWrite(activeDbPath, memoryData);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EROFS' || e.code === 'ENOENT') {
      switchToFallback(e);
      save(memoryData);
      return;
    }
    throw e;
  }

  if (notify) {
    for (const listener of listeners) {
      try { listener(clone(memoryData)); } catch {}
    }
  }
}

function get() {
  return load();
}

function set(data) {
  save(data);
}

function replace(data, { notify = false } = {}) {
  save(data || defaults(), { notify });
}

function onSet(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = { get, set, replace, onSet };
