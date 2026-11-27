"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { outputDirectory } = require("./build.cjs");

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
  return http.createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", ...SECURITY_HEADERS });
      response.end();
      return;
    }

    let relativePath;
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch (error) {
      response.writeHead(400, SECURITY_HEADERS);
      response.end("Bad request");
      return;
    }

    if (!relativePath) relativePath = "index.html";
    else if (relativePath.endsWith("/")) relativePath += "index.html";
    const root = path.resolve(outputDirectory);
    const filePath = path.resolve(root, relativePath);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404, SECURITY_HEADERS);
      response.end("Not found");
      return;
    }

    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) {
        response.writeHead(404, SECURITY_HEADERS);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": CONTENT_TYPES.get(path.extname(filePath)) || "application/octet-stream",
        "Content-Length": stat.size,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      stream.on("error", (streamError) => {
        console.error(`Couldn't serve ${relativePath}:`, streamError.message);
        if (!response.headersSent) response.writeHead(500, SECURITY_HEADERS);
        response.destroy();
      });
      stream.pipe(response);
    });
  });
}

function start() {
  const port = Number(process.env.PORT || "4180");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }

  const server = createServer();
  server.once("error", (error) => {
    console.error(`Couldn't start the website at http://127.0.0.1:${port}/: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Motion Organizer website is ready at ${url}`);
    if (process.argv.includes("--open") && process.platform === "win32") {
      execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], (error) => {
        if (error) console.error("Could not open the default browser:", error.message);
      });
    }
    console.log("Leave this window open while you use the website. Press Ctrl+C to stop the server.");
  });
}

if (require.main === module) start();

module.exports = { createServer };
