import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('../../apps/dashboard/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../../apps/dashboard/index.html', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../../apps/dashboard/config.js', import.meta.url), 'utf8');

test('production dashboard has no obsolete API URL and demo mode is opt-in', () => {
  assert.doesNotMatch(app, /njwgew4b9k\.execute-api\.ap-south-1\.amazonaws\.com/);
  assert.doesNotMatch(html, /njwgew4b9k\.execute-api\.ap-south-1\.amazonaws\.com/);
  assert.match(app, /demoMode === true/);
  assert.match(config, /demoMode: false/);
});

test('dashboard API calls use the shared configured base URL', () => {
  assert.doesNotMatch(app, /fetch\(`\$\{apiUrl\(\)\}/);
  assert.match(app, /fetch\(`\$\{requireApiUrl\(\)\}/);
});
