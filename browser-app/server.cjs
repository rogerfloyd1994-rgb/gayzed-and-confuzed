"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-cache",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function createServer() {
  const webRoot = __dirname;
  return http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", ...SECURITY_HEADERS });
      response.end();
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch (error) {
      response.writeHead(400, SECURITY_HEADERS);
      response.end("Bad request");
      return;
    }

    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    if (fileName !== "index.html" &&
        fileName !== "styles.css" &&
        fileName !== "app.js" &&
        fileName !== "manifest.webmanifest" &&
        fileName !== "icon.svg" &&
        fileName !== "sw.js") {
      response.writeHead(404, SECURITY_HEADERS);
      response.end("Not found");
      return;
    }

    const filePath = path.join(webRoot, fileName);
    fs.readFile(filePath, (error, content) => {
      if (error) {
        console.error(`Unable to serve ${fileName}:`, error);
        response.writeHead(500, SECURITY_HEADERS);
        response.end("Could not load the app.");
        return;
      }

      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": CONTENT_TYPES.get(path.extname(fileName)) || "application/octet-stream",
        "Content-Length": content.length,
      });
      response.end(request.method === "HEAD" ? undefined : content);
    });
  });
}

function start() {
  const port = Number(process.env.PORT || "4173");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }

  const server = createServer();
  server.once("error", (error) => {
    console.error(`Couldn't start the browser app at http://127.0.0.1:${port}/: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Motion Organizer is ready at ${url}`);
    if (process.argv.includes("--open") && process.platform === "win32") {
      execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], (error) => {
        if (error) console.error("Could not open the default browser:", error.message);
      });
    }
    console.log("Leave this window open while you use the app. Press Ctrl+C to stop the local server.");
  });
}

if (require.main === module) start();

module.exports = { createServer };
