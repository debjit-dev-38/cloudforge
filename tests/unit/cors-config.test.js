import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const template = fs.readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const samconfig = fs.readFileSync(new URL('../../samconfig.toml', import.meta.url), 'utf8');

test('SAM deployment origins include local and production dashboard origins', () => {
  assert.match(template, /AllowOrigins:\s*!Ref AllowedOrigins/);
  assert.match(samconfig, /AllowedOrigins=\\"http:\/\/localhost:5173,https:\/\/cloudforge-dashboard\.vercel\.app\\"/);
});

test('HTTP API CORS allows headers used by the frontend and supported methods', () => {
  for (const header of ['authorization', 'content-type', 'x-api-key', 'idempotency-key', 'x-request-id']) {
    assert.match(template, new RegExp(`\\s+- ${header}\\s`));
  }
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    assert.match(template, new RegExp(`\\s+- ${method}\\s`));
  }
});
