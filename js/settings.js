// User preferences, persisted in localStorage.
const KEY = 'scan-settings-v1';

export const DEFAULTS = {
  glare: true,          // guided extra shots to remove glare
  preset: 'auto',       // none | auto | restore | bw
  autoRotate: true,     // rotate using faces
  outputMax: 3200,      // long side of saved images
  quality: 0.92,        // JPEG quality
  camera: 'high',       // high | standard
  snap: true,           // snap aspect ratio to common print sizes
  multi: false,         // album-page mode (several photos at once)
  sharpen: 25,          // default sharpening
  autoSave: false,      // save camera scans straight away and keep scanning
};

let current = null;

export function getSettings() {
  if (current) return current;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
  current = { ...DEFAULTS, ...saved };
  return current;
}

export function setSetting(key, value) {
  getSettings()[key] = value;
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { /* private mode */ }
}
