// Run with: node test_uploads.mjs
// Boots the real server.js in DEV mode against a throwaway UPLOAD_DIR and
// exercises /uploads/* over raw HTTP — byte ranges are what makes proofs
// play in the Telegram / iOS video player, so they need real coverage.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (a, b, m) => { if (a === b) { pass++; console.log('  ok', m); } else { fail++; console.log(`  FAIL: ${m} (got ${a}, want ${b})`); } };
const ok = (c, m) => { if (c) { pass++; console.log('  ok', m); } else { fail++; console.log('  FAIL:', m); } };

const PORT = 3987;
const SIZE = 100000;
const body = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

const upDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bountly-up-'));
fs.writeFileSync(path.join(upDir, 'sub_1_abc.mp4'), body);

// raw request so we control the exact path bytes (fetch would normalise "..")
function raw(rawPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: rawPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: upDir, BOT_TOKEN: '', NODE_ENV: '', DATABASE_URL: '', LEDGER: '', SOLANA: '' },
  stdio: 'ignore',
});

async function waitForBoot() {
  for (let i = 0; i < 100; i++) {
    try { await raw('/uploads/sub_1_abc.mp4', {}, 'HEAD'); return true; }
    catch { await new Promise(r => setTimeout(r, 100)); }
  }
  return false;
}

function done() {
  srv.kill();
  fs.rmSync(upDir, { recursive: true, force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

try {
  if (!await waitForBoot()) throw new Error('server never came up');

  console.log('\n-- full GET --');
  const full = await raw('/uploads/sub_1_abc.mp4');
  eq(full.status, 200, 'full request is 200');
  eq(full.headers['accept-ranges'], 'bytes', 'advertises Accept-Ranges: bytes');
  eq(full.headers['content-type'], 'video/mp4', 'mp4 content type');
  eq(Number(full.headers['content-length']), SIZE, 'Content-Length is the file size');
  ok(full.body.equals(body), 'full body matches byte for byte');

  console.log('\n-- ranges (what the iOS / Telegram player actually sends) --');
  const first = await raw('/uploads/sub_1_abc.mp4', { Range: 'bytes=0-' });
  eq(first.status, 206, '"bytes=0-" gets a 206, not a 200');
  eq(first.headers['content-range'], `bytes 0-${SIZE - 1}/${SIZE}`, 'open-ended range covers the file');
  ok(first.body.equals(body), 'open-ended range returns everything');

  const mid = await raw('/uploads/sub_1_abc.mp4', { Range: 'bytes=100-199' });
  eq(mid.status, 206, 'closed range is 206');
  eq(mid.headers['content-range'], `bytes 100-199/${SIZE}`, 'Content-Range echoes the window');
  eq(Number(mid.headers['content-length']), 100, 'Content-Length is the window size');
  ok(mid.body.equals(body.subarray(100, 200)), 'closed range returns the right bytes');

  const suffix = await raw('/uploads/sub_1_abc.mp4', { Range: 'bytes=-100' });
  eq(suffix.status, 206, 'suffix range is 206');
  eq(suffix.headers['content-range'], `bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`, 'suffix range counts from the end');
  ok(suffix.body.equals(body.subarray(SIZE - 100)), 'suffix range returns the tail');

  const past = await raw('/uploads/sub_1_abc.mp4', { Range: `bytes=${SIZE + 10}-` });
  eq(past.status, 416, 'range past EOF is 416');
  eq(past.headers['content-range'], `bytes */${SIZE}`, '416 reports the real size');

  const clamped = await raw('/uploads/sub_1_abc.mp4', { Range: `bytes=99990-${SIZE + 500}` });
  eq(clamped.status, 206, 'over-long end is clamped, not rejected');
  eq(clamped.headers['content-range'], `bytes 99990-${SIZE - 1}/${SIZE}`, 'end clamped to the last byte');

  console.log('\n-- HEAD --');
  const head = await raw('/uploads/sub_1_abc.mp4', {}, 'HEAD');
  eq(head.status, 200, 'HEAD is 200');
  eq(Number(head.headers['content-length']), SIZE, 'HEAD reports the size');
  eq(head.body.length, 0, 'HEAD sends no body');

  console.log('\n-- traversal / missing --');
  eq((await raw('/uploads/../server.js')).status, 404, 'literal ../ is refused');
  eq((await raw('/uploads/..%2Fserver.js')).status, 404, 'encoded ../ is refused');
  eq((await raw('/uploads/nope.mp4')).status, 404, 'missing file is 404');
  eq((await raw('/uploads/')).status, 404, 'bare directory is 404');

  console.log('\n-- static whitelist still holds --');
  eq((await raw('/data.json')).status, 404, 'data.json is not servable');
  eq((await raw('/server.js')).status, 404, 'server.js is not servable');
  eq((await raw('/.env')).status, 404, '.env is not servable');
  eq((await raw('/app')).status, 200, 'the mini app is servable');

  console.log('\n-- framing / CSP --');
  const app = await raw('/app');
  ok(!app.headers['x-frame-options'], 'no X-Frame-Options (it blocked Telegram Web)');
  ok(/frame-ancestors[^;]*web\.telegram\.org/.test(app.headers['content-security-policy'] || ''),
    'mini app lets Telegram frame it');
  const adm = await raw('/admin');
  ok(/frame-ancestors 'none'/.test(adm.headers['content-security-policy'] || ''),
    'dashboard refuses all framing');
  eq(app.headers['x-content-type-options'], 'nosniff', 'nosniff still set');
  // Both of these were silently broken by the CSP. The fonts made the app
  // look wrong; the Telegram SDK made it not work at all, because without it
  // initData is empty and every request fails auth once BOT_TOKEN is set.
  ok(/script-src[^;]*https:\/\/telegram\.org/.test(app.headers['content-security-policy'] || ''),
    'the Telegram SDK is allowed to load — without it nothing authenticates');
  const csp = app.headers['content-security-policy'] || '';
  ok(!/fonts\.googleapis\.com/.test(csp), 'no external font host is needed — they are self-hosted');

  console.log('\n-- self-hosted fonts are actually reachable --');
  for (const f of ['anton-latin', 'anton-latin-ext', 'archivo-latin', 'archivo-latin-ext',
                   'jetbrains-latin', 'jetbrains-latin-ext']) {
    const r = await raw(`/fonts/${f}.woff2`);
    eq(r.status, 200, `${f}.woff2 is served`);
  }
  eq((await raw('/fonts/anton-latin.woff2')).headers['content-type'], 'font/woff2', 'served as a font');
  // The whole point of the /fonts/ prefix is that it stays as tight as the
  // whitelist it sits next to.
  eq((await raw('/fonts/server.js')).status, 404, 'only woff2 comes out of /fonts/');
  eq((await raw('/fonts/..%2Fdata.json')).status, 404, 'no traversal out of /fonts/');
  // index.html is served at /app, /app/ and /index.html, so a relative asset
  // path resolves three different ways. These have to be root-absolute.
  const html = (await raw('/app')).body.toString('utf8');
  ok(!/src="fonts\/|url\(fonts\//.test(html), 'font URLs are root-absolute');
  ok(/src="\/bountly-bg\.mp4"/.test(html), 'the background video URL is root-absolute too');
  ok(!app.headers['strict-transport-security'], 'no HSTS on a plain-HTTP request');
  const https = await raw('/app', { 'X-Forwarded-Proto': 'https' });
  ok(/max-age=/.test(https.headers['strict-transport-security'] || ''), 'HSTS set when proxied over https');

  console.log('\n-- avatar proxy is rate limited --');
  let sawLimit = false;
  for (let i = 0; i < 70; i++) {
    if ((await raw('/api/player/nobody/avatar')).status === 429) { sawLimit = true; break; }
  }
  ok(sawLimit, 'avatar proxy returns 429 once the per-minute budget is spent');
} catch (e) {
  fail++; console.log('  FAIL: threw', e.message);
}
done();
