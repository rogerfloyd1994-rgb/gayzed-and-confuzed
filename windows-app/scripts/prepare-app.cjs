"use strict";

const fs = require("node:fs");
const path = require("node:path");

const source = path.resolve(__dirname, "..", "..", "browser-app");
const destination = path.resolve(__dirname, "..", "web");

if (!fs.existsSync(path.join(source, "index.html"))) {
  throw new Error(`The browser app entry point was not found: ${source}`);
}

fs.cpSync(source, destination, { recursive: true, force: true });
console.log(`Prepared Motion Organizer web app: ${destination}`);
