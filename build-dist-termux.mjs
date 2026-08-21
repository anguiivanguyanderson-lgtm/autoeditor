// Build the on-device Android (Termux) distributable. Unlike the Windows/mac
// builds there is NO single exe — Android/Termux uses its OWN native node +
// ffmpeg (installed via `pkg install nodejs ffmpeg`), so we ship the bundled
// server JS + UI + font + a start script. Runs on any dev machine (esbuild is
// cross-platform); no phone needed to produce it.
//
//   node build-dist-termux.mjs
//
// Produces:  dist/AutoEditor-android.zip
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(os.tmpdir(), "autoeditor-build-termux");
const OUT = path.join(STAGE, "AutoEditor-android");

function run(cmd, cwd = ROOT) { console.log("> " + cmd); execSync(cmd, { cwd, stdio: "inherit" }); }

const START_SH = `#!/usr/bin/env bash
# AutoEditor for Android (Termux).  Run:  bash start.sh
cd "$(dirname "$0")"

# First run: auto-install Node.js + ffmpeg if they're missing (needs internet).
if ! command -v node >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
  echo "First run: installing Node.js and ffmpeg (one-time, needs internet)..."
  yes | pkg update >/dev/null 2>&1 || pkg update -y
  pkg install -y nodejs ffmpeg
fi

if ! command -v node >/dev/null 2>&1; then echo "Node.js install failed. Try: pkg install nodejs"; exit 1; fi
FF="$(command -v ffmpeg)"
if [ -z "$FF" ]; then echo "ffmpeg install failed. Try: pkg install ffmpeg"; exit 1; fi
export FFMPEG_PATH="$FF"
export CAPTION_FONT_PATH="$(pwd)/caption.ttf"
export FRONTEND_DIR="$(pwd)/out"
export OPEN_BROWSER=0
export PORT="\${PORT:-4000}"
echo "AutoEditor is running."
echo "Open  http://localhost:\${PORT}  in Chrome/Firefox on this phone."
echo "Keep this Termux session open. Press Ctrl+C to stop."
node bundle.cjs
`;

const README = `AutoEditor for Android (via Termux)
Runs entirely on your phone. Nothing is uploaded.

SETUP
1. Install Termux from F-Droid (https://f-droid.org).
   Do NOT use the old Play Store version.
2. Open Termux and give it file access (once):
     termux-setup-storage
3. Go to this folder (e.g. if it's in Downloads):
     cd ~/storage/downloads/AutoEditor-android
4. Run:
     bash start.sh

That's it. On the first run start.sh installs Node.js + ffmpeg for you
(one-time, needs internet), then starts the app.

USE
   Open  http://localhost:4000  in Chrome or Firefox on the same phone.
   To stop: return to Termux and press Ctrl+C.
   Next time, just run "bash start.sh" again.

NOTES
- Rendering runs on the phone's CPU; short/medium videos work best.
- After the one-time setup, no internet is needed.
`;

async function main() {
  console.log("[1/5] Building frontend...");
  if (!existsSync(path.join(ROOT, "node_modules"))) run("npm install");
  run("npm run build");

  console.log("[2/5] Ensuring server deps (for bundling)...");
  if (!existsSync(path.join(ROOT, "server", "node_modules"))) run("npm install", path.join(ROOT, "server"));

  console.log("[3/5] Clean staging...");
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  console.log("[4/5] Bundling server + assembling folder...");
  run(`npx --yes esbuild server/index.js --bundle --platform=node --format=cjs --minify --outfile="${path.join(OUT, "bundle.cjs")}"`);
  copyFileSync(path.join(ROOT, "server", "assets", "caption.ttf"), path.join(OUT, "caption.ttf"));
  cpSync(path.join(ROOT, "out"), path.join(OUT, "out"), { recursive: true });
  writeFileSync(path.join(OUT, "start.sh"), START_SH.replace(/\r\n/g, "\n"));
  writeFileSync(path.join(OUT, "READ ME FIRST.txt"), README);

  console.log("[5/5] Zipping...");
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const zip = path.join(DIST, "AutoEditor-android.zip");
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force"`,
    { stdio: "inherit" },
  );
  rmSync(STAGE, { recursive: true, force: true });
  console.log("\nDone. Share:  " + zip);
}

main().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
