# Motion Detection Organizer

Private, on-device motion detection for Android, Windows, and modern web browsers. The [Android app project](./android), [browser app](./browser-app), and [Windows desktop app](./windows-app) share the same video/camera workflow. Videos are not uploaded or copied; local results are saved on each device.

Installers and the ready-to-run browser app for this PC are in the Desktop `Appimade` folder. See the [Appimade quick start](./APPIMADE-README.txt).

## Website

The public product landing page and the existing browser app are published together from the [`website`](./website) build. With Node.js installed, preview the combined website locally:

```powershell
node website/build.cjs
node website/server.cjs --open
```

The landing page opens at `http://127.0.0.1:4180/`; **Open the app** links to `http://127.0.0.1:4180/app/`. Upload the contents of `website\dist` to a static website host to publish them. The site uses relative links and includes the browser app, installable web manifest, and offline app shell. A site hosted over HTTPS can request camera permission when visitors choose to start the camera.

Run the website server checks with `node --test website/server.test.cjs`.

## Windows desktop app

Open [windows-app](./windows-app) with Node.js LTS installed, then run:

```powershell
npm install
npm start
```

Create a Windows installer with:

```powershell
npm run build:win
```

The installer is written to `windows-app\release\Motion Organizer-Setup-1.0.0.exe`. Windows builds use Electron and include the browser app.

## macOS disk image

A macOS computer is required to build a `.dmg`. On the Mac, copy or clone this project, open Terminal in `windows-app`, and run:

```sh
npm ci
npm run build:mac
```

The universal Intel/Apple Silicon disk image is written to `windows-app/release/Motion Organizer-macOS-1.0.0-universal.dmg`. Alternatively, push the project to a GitHub repository and run the **Build macOS DMG** workflow from its Actions tab; download the `motion-organizer-macos-dmg` artifact when the workflow finishes.

The DMG built by this project is not code-signed or notarized. macOS may warn when opening it. For normal distribution, sign the app with an Apple Developer ID certificate and notarize it; do not disable macOS security protections.

## Browser app and installation

Start the local browser app from the repository root:

```powershell
node browser-app/server.cjs --open
```

The server opens `http://127.0.0.1:4173/` in your default browser. Alternatively, double-click `browser-app\start-windows.cmd`. Keep the server window open while using the app and press Ctrl+C to stop it. Choose **Install app** in your browser to add it to the Windows desktop; Chrome and Edge also support adding it to an Android home screen.

The browser app detects motion on-device, lets you create and resize named motion regions, and saves reports and recent results in local browser storage. Import 10 or more local videos or screenshots; videos are analyzed one at a time, and still images are stored as references rather than treated as motion. Live-camera recording can be set to event clips (starts at detection, with about five seconds after; no pre-event buffer yet), continuous 10-minute segments, or off; recordings stay on the device. You can label and filter events, add custom activity labels, configure local motion notifications, and create factual quiet-period reports. Labels are manual and do not train an object detector. The installable web app caches its shell for offline use. Import/export report-only JSON backups to move reports between devices using a cloud drive you choose; backups are not automatically uploaded and do not include clips. Backup files contain report titles, labels, timestamps, and summaries, so keep them private. The browser app currently monitors one live camera at a time; it does not yet monitor 10 cameras concurrently.

Camera access requires HTTPS, `localhost`, or the Windows desktop app. The browser app does not identify faces, classify screams/glass-breaking/bangs, or send remote push alerts. There is no automatic cloud sync or remote push alert service. The browser app works offline after it has been installed and its shell cached; report backup files can be moved through a cloud drive you choose.

Run the standalone browser-server checks with `node --test browser-app/server.test.cjs`.

## Android app

Open the [`android`](./android) folder in Android Studio, allow Gradle to sync, then run the `app` configuration on an Android device or emulator (API 26 or newer).

Build a debug APK from the `android` folder with:

```powershell
gradle :app:assembleDebug
```

The APK is written to `app\build\outputs\apk\debug\app-debug.apk`. The current version 1.3 debug APK targets Android API 36 and is for installation/testing; it is not a Play Store release.

The Android app analyzes selected videos, monitors one back camera while the camera screen is open, and can save short motion-triggered clips locally. Clip recording is opt-in; it begins after detection and stops after five quiet seconds or 60 seconds, and the app keeps at most 20 clips / 250 MB. Reports describe observed motion samples and activity periods. Local motion notifications are off until enabled; notification permission is requested only then. Image labels for likely people and pets are best-effort, not identification. Camera monitoring stops when the app is backgrounded. Reports can be exported/imported as JSON through Android's document picker, including a cloud-drive provider if you choose one; clips are not included. There is no automatic cloud sync, background camera service, sound classification, face recognition, or remote push. Backup files contain report titles, labels, timestamps, and summaries, so keep them private. Google Play publication still requires a signed release bundle, store listing, and policy review.

## Python command-line tool

[`motion_detector.py`](./motion_detector.py) remains available for desktop and container workflows. It requires Python 3.11+, OpenCV, and NumPy:

```powershell
python -m pip install opencv-python numpy
python motion_detector.py --search-dir "C:\path\to\videos"
```

For the full set of command-line options, run:

```powershell
python motion_detector.py --help
```
