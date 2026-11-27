"use strict";

const { app, BrowserWindow, net, protocol, session, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP_ORIGIN = "motion-organizer://app/";
const WEB_ROOT = app.isPackaged
  ? path.join(app.getAppPath(), "web")
  : path.resolve(__dirname, "..", "browser-app");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "motion-organizer",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveWebAsset(requestUrl) {
  const request = new URL(requestUrl);
  const assetPath = decodeURIComponent(request.pathname);
  const rootPath = path.resolve(WEB_ROOT);
  const filePath = path.resolve(rootPath, `.${assetPath}`);
  if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }
  return filePath;
}

function registerLocalAppProtocol() {
  protocol.handle("motion-organizer", (request) => {
    if (new URL(request.url).host !== "app") {
      return new Response("Not found", { status: 404 });
    }
    const filePath = resolveWebAsset(request.url);
    if (!filePath) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(filePath).href);
  });
}

function configureCameraPermissions() {
  const appSession = session.defaultSession;
  appSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const isLocalApp = webContents.getURL().startsWith(APP_ORIGIN);
    const isCameraPermission = permission === "media" &&
      details.mediaTypes?.includes("video");
    callback(isLocalApp && isCameraPermission);
  });
  appSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) =>
    permission === "media" &&
    requestingOrigin.startsWith(APP_ORIGIN) &&
    webContents?.getURL().startsWith(APP_ORIGIN),
  );
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 350,
    minHeight: 640,
    show: false,
    title: "Motion Organizer",
    backgroundColor: "#f6f7fb",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) event.preventDefault();
  });
  window.loadURL(`${APP_ORIGIN}index.html`).catch((error) => {
    console.error("Could not load Motion Organizer.", error);
    app.exit(1);
  });
}

app.whenReady().then(() => {
  registerLocalAppProtocol();
  configureCameraPermissions();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("Could not initialize Motion Organizer.", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
