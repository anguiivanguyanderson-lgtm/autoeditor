// Build the shareable, zero-install macOS distributable (Node SEA + esbuild).
// MUST run on macOS (it uses `codesign`, which only exists on a Mac) — normally
// via the GitHub Actions workflow .github/workflows/build-mac.yml, which runs it
// on macos-14 (Apple Silicon / arm64) and macos-13 (Intel / x64).
//
//   node build-dist-mac.mjs
//
// Produces:  dist/AutoEditor-mac-<arch>.zip
// The single executable embeds the server; ffmpeg, the caption font and the UI
// ship alongside it and are self-located at runtime. It ad-hoc code-signs the
// binaries so macOS will run them (no Apple Developer ID = users right-click →
// Open once; see the READ ME FIRST it writes).
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.error("build-dist-mac.mjs must run on macOS (it needs codesign). Use the GitHub Actions workflow.");
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const ARCH = process.arch; // "arm64" or "x64"
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(os.tmpdir(), "autoeditor-build-mac");
const OUT = path.join(STAGE, "AutoEditor");
const WORK = path.join(STAGE, ".work");

function run(cmd, cwd = ROOT) { console.log("> " + cmd); execSync(cmd, { cwd, stdio: "inherit" }); }
function sign(file) { run(`codesign --sign - --force --timestamp=none "${file}"`); }

async function main() {
  console.log(`[1/7] Building frontend (${ARCH})...`);
  if (!existsSync(path.join(ROOT, "node_modules"))) run("npm install");
  run("npm run build");

  console.log("[2/7] Ensuring server deps (mac ffmpeg + source)...");
  if (!existsSync(path.join(ROOT, "server", "node_modules"))) run("npm install", path.join(ROOT, "server"));

  console.log("[3/7] Clean staging...");
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  console.log("[4/7] Bundling server (esbuild)...");
  run(`npx --yes esbuild server/index.js --bundle --platform=node --format=cjs --minify --outfile="${path.join(WORK, "bundle.cjs")}"`);

  console.log("[5/7] Compiling AutoEditor (Node SEA)...");
  // Use the running node (correct arch) as the base binary; re-sign after inject.
  const base = path.join(WORK, "AutoEditor");
  copyFileSync(process.execPath, base);
  run(`codesign --remove-signature "${base}"`);
  writeFileSync(
    path.join(WORK, "sea-config.json"),
    JSON.stringify({ main: "bundle.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true }),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: WORK, stdio: "inherit" });
  run(`npx --yes postject "${base}" NODE_SEA_BLOB "${path.join(WORK, "sea-prep.blob")}" --sentinel-fuse ${FUSE} --macho-segment-name NODE_SEA`);
  sign(base); // ad-hoc sign so macOS will launch it
  const exe = path.join(OUT, "AutoEditor");
  copyFileSync(base, exe);
  chmodSync(exe, 0o755);

  console.log("[6/7] Assembling folder...");
  const ffmpeg = path.join(OUT, "ffmpeg");
  copyFileSync(path.join(ROOT, "server", "node_modules", "ffmpeg-static", "ffmpeg"), ffmpeg);
  chmodSync(ffmpeg, 0o755);
  sign(ffmpeg);
  copyFileSync(path.join(ROOT, "server", "assets", "caption.ttf"), path.join(OUT, "caption.ttf"));
  cpSync(path.join(ROOT, "out"), path.join(OUT, "out"), { recursive: true });

  // Double-click launcher (opens Terminal, runs the app, browser auto-opens).
  const cmd = path.join(OUT, "AutoEditor.command");
  writeFileSync(cmd, '#!/bin/bash\ncd "$(dirname "$0")"\n./AutoEditor\n');
  chmodSync(cmd, 0o755);

  writeFileSync(path.join(OUT, "READ ME FIRST.txt"),
`AutoEditor for macOS (${ARCH})

1) Move this AutoEditor folder anywhere you like (e.g. Applications).
2) Double-click "AutoEditor.command". Your browser opens the editor.

First launch — macOS Gatekeeper:
  Because this app isn't from the App Store, macOS may say it's from an
  "unidentified developer". Either:
   - Right-click "AutoEditor.command" and "AutoEditor" -> Open -> Open, OR
   - Open Terminal and run (drag the folder in to get its path):
       xattr -dr com.apple.quarantine "/path/to/AutoEditor"

Keep the Terminal window open while you work; close it to stop the app.
Everything runs on your Mac — nothing is uploaded.
`);

  console.log("[7/7] Zipping...");
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  const zip = path.join(DIST, `AutoEditor-mac-${ARCH}.zip`);
  // ditto preserves the executable bits and code signatures inside the zip.
  run(`ditto -c -k --sequesterRsrc --keepParent "${OUT}" "${zip}"`);
  rmSync(STAGE, { recursive: true, force: true });

  console.log("\nDone. Share:  " + zip);
}

main().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
