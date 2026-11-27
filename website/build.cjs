"use strict";

const fs = require("node:fs");
const path = require("node:path");

const websiteDirectory = __dirname;
const repositoryDirectory = path.resolve(websiteDirectory, "..");
const outputDirectory = path.join(websiteDirectory, "dist");
const browserSourceDirectory = path.join(repositoryDirectory, "browser-app");

const landingFiles = ["index.html", "styles.css", "script.js", "icon.svg"];
const browserFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "manifest.webmanifest",
  "icon.svg",
  "sw.js",
];

function copyRequiredFiles(sourceDirectory, destinationDirectory, fileNames) {
  fs.mkdirSync(destinationDirectory, { recursive: true });
  for (const fileName of fileNames) {
    const source = path.join(sourceDirectory, fileName);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Required website file was not found: ${source}`);
    }
    fs.copyFileSync(source, path.join(destinationDirectory, fileName));
  }
}

function build() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  copyRequiredFiles(websiteDirectory, outputDirectory, landingFiles);
  copyRequiredFiles(browserSourceDirectory, path.join(outputDirectory, "app"), browserFiles);

  const landing = fs.readFileSync(path.join(outputDirectory, "index.html"), "utf8");
  const browserApp = fs.readFileSync(path.join(outputDirectory, "app", "index.html"), "utf8");
  if (!landing.includes('href="./app/"')) {
    throw new Error("The landing page does not link to the bundled browser app.");
  }
  if (!browserApp.includes("manifest.webmanifest")) {
    throw new Error("The bundled browser app is missing its installable web manifest.");
  }

  console.log(`Website built successfully: ${outputDirectory}`);
  console.log("Published files include the landing page and the existing browser app at /app/.");
}

if (require.main === module) build();

module.exports = { build, outputDirectory };
