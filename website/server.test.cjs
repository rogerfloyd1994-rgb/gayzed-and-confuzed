"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { build, outputDirectory } = require("./build.cjs");
const { createServer } = require("./server.cjs");

const server = createServer();
let origin;

before(async () => {
  build();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
});

test("builds and serves a secure, mobile-friendly product website", async () => {
  const response = await fetch(origin);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(html, /See what moves/);
  assert.match(html, /Your recordings aren't uploaded or copied/);
  assert.match(html, /href="\.\/app\/"/);
  assert.ok(html.indexOf("styles.css") < html.indexOf("</head>"));
  assert.equal(fs.existsSync(path.join(outputDirectory, "styles.css")), true);
});

test("publishes the working browser app and installable manifest under /app/", async () => {
  const [appResponse, cssResponse, manifestResponse, workerResponse] = await Promise.all([
    fetch(`${origin}/app/`),
    fetch(`${origin}/app/styles.css`),
    fetch(`${origin}/app/manifest.webmanifest`),
    fetch(`${origin}/app/sw.js`),
  ]);
  const [app, manifest] = await Promise.all([appResponse.text(), manifestResponse.json()]);

  assert.equal(appResponse.status, 200);
  assert.match(app, /Choose your source/);
  assert.equal(cssResponse.status, 200);
  assert.match(cssResponse.headers.get("content-type"), /^text\/css/);
  assert.equal(manifestResponse.status, 200);
  assert.equal(manifest.display, "standalone");
  assert.equal(workerResponse.status, 200);
});

test("rejects uploads, traversal, and unpublished project files", async () => {
  const [postResponse, traversalResponse, projectFileResponse, invalidEscapeResponse] = await Promise.all([
    fetch(origin, { method: "POST" }),
    fetch(`${origin}/%2e%2e%2fREADME.md`),
    fetch(`${origin}/windows-app/package.json`),
    fetch(`${origin}/%E0%A4%A`),
  ]);

  assert.equal(postResponse.status, 405);
  assert.equal(postResponse.headers.get("allow"), "GET, HEAD");
  assert.equal(traversalResponse.status, 404);
  assert.equal(projectFileResponse.status, 404);
  assert.equal(invalidEscapeResponse.status, 400);
});
