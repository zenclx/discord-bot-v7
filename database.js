const fs = require('fs');
const path = require('path');

const FALLBACK_DB_PATH = path.join(__dirname, 'data.json');
const PRIMARY_DB_PATH = process.env.DATA_PATH || FALLBACK_DB_PATH;
const ELO_BACKUP_PATH = path.join(__dirname, 'elo-backup.json');
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

function restoreEloFromBackup(data) {
  try {
    if (!fs.existsSync(ELO_BACKUP_PATH)) return data;
    const backup = JSON.parse(fs.readFileSync(ELO_BACKUP_PATH, 'utf8'));
    if (!backup?.elo || Object.keys(backup.elo).length === 0) return data;
    const currentCount = Object.keys(data.elo || {}).length;
    const backupCount = Object.keys(backup.elo).length;
    if (backupCount > currentCount) {
      console.log(`ELO backup has ${backupCount} players vs ${currentCount} in data.json — restoring from elo-backup.json.`);
      data.elo = backup.elo;
    }
  } catch {}
  return data;
}

function load() {
  if (memoryData) return clone(memoryData);

  try {
    if (!fs.existsSync(activeDbPath)) {
      const data = restoreEloFromBackup(defaults());
      ensureWritable(activeDbPath);
      atomicWrite(activeDbPath, data);
      memoryData = data;
      return clone(memoryData);
    }
    const data = JSON.parse(fs.readFileSync(activeDbPath, 'utf8'));
    memoryData = restoreEloFromBackup(data);
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

  // Keep a dedicated ELO backup so it can be recovered if data.json is lost or corrupted
  if (memoryData.elo && Object.keys(memoryData.elo).length > 0) {
    try {
      atomicWrite(ELO_BACKUP_PATH, { elo: memoryData.elo, savedAt: Date.now() });
    } catch {}
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
