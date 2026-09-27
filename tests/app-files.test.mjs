// Consistency checks for the installable app: the version the app reports
// must match version.json (used by "Check for updates"), and every file
// the service worker caches for offline use must exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root } from './helpers.mjs';

test('version.json matches the app version', () => {
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  const appVersion = app.match(/APP_VERSION = '([^']+)'/)[1];
  const json = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
  assert.equal(json.version, appVersion);
});

test('every offline file exists', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  const list = [...sw.matchAll(/'([^']+\.(?:html|js|css|json|webmanifest|png|svg|onnx))'/g)].map((m) => m[1]);
  assert.ok(list.length > 15, 'file list found');
  for (const f of list) assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
});
