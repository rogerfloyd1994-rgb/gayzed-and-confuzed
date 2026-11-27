"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const { createServer } = require("./server.cjs");

const server = createServer();
let origin;

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
});

test("serves the browser app with the security and install headers it needs", async () => {
  const response = await fetch(origin);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(html, /Motion Organizer/);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /id="region-layer"/);
  assert.match(html, /id="recording-mode"/);
  assert.match(html, /id="export-backup"/);
  assert.match(html, /id="import-backup"/);
  assert.match(html, /multiple hidden/);
});

test("serves install metadata and the motion-analysis script", async () => {
  const [manifestResponse, appResponse, workerResponse] = await Promise.all([
    fetch(`${origin}/manifest.webmanifest`),
    fetch(`${origin}/app.js`),
    fetch(`${origin}/sw.js`),
  ]);
  const [manifest, script, worker] = await Promise.all([
    manifestResponse.json(),
    appResponse.text(),
    workerResponse.text(),
  ]);

  assert.equal(manifestResponse.status, 200);
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.icons[0].sizes, /192x192/);
  assert.equal(appResponse.status, 200);
  assert.match(script, /function changedRegions/);
  assert.match(script, /startEventRecording/);
  assert.match(script, /reportQuietPeriod/);
  assert.match(script, /async function exportReports/);
  assert.match(script, /async function importReports/);
  assert.match(script, /MAX_BACKUP_BYTES/);
  assert.equal(workerResponse.status, 200);
  assert.match(worker, /motion-organizer-shell-v3/);
  assert.match(worker, /caches\.open/);
});

test("does not serve paths outside the browser app", async () => {
  const responses = await Promise.all([
    fetch(`${origin}/server.cjs`),
    fetch(`${origin}/%2e%2e%2fREADME.md`),
    fetch(`${origin}/%E0%A4%A`),
  ]);

  assert.equal(responses[0].status, 404);
  assert.equal(responses[1].status, 404);
  assert.equal(responses[2].status, 400);
});

test("does not accept methods that could modify local files", async () => {
  const response = await fetch(origin, { method: "POST" });

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});
