// Build the shareable, zero-install Windows distributable as a single compiled
// exe (Node SEA + esbuild). Run on a dev machine with Node + npm + internet:
//   node build-dist.mjs      (or double-click build-dist.bat)
// Produces:  dist\StoryToVideo.zip
//
// The exe embeds the bundled server; ffmpeg, the caption font, and the UI ship
// alongside it and are located via env vars set by the packaged start.bat.
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, cpSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NODE_VER = "v20.18.1";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(os.tmpdir(), "autoeditor-build");
const OUT = path.join(STAGE, "AutoEditor");
const WORK = path.join(STAGE, ".work");

function run(cmd, cwd = ROOT) { console.log("> " + cmd); execSync(cmd, { cwd, stdio: "inherit" }); }

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const f = createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
    }).on("error", reject);
  });
}

async function main() {
  console.log("[1/7] Building frontend...");
  if (!existsSync(path.join(ROOT, "node_modules"))) run("npm install");
  run("npm run build");

  console.log("[2/7] Ensuring server deps (ffmpeg + bundling source)...");
  if (!existsSync(path.join(ROOT, "server", "node_modules"))) run("npm install", path.join(ROOT, "server"));

  console.log("[3/7] Clean staging...");
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  console.log("[4/7] Bundling server (esbuild)...");
  run(`npx --yes esbuild server/index.js --bundle --platform=node --format=cjs --minify --outfile="${path.join(WORK, "bundle.cjs")}"`);

  console.log("[5/7] Compiling AutoEditor.exe (Node SEA)...");
  const nodeExe = path.join(WORK, "node.exe");
  await download(`https://nodejs.org/dist/${NODE_VER}/win-x64/node.exe`, nodeExe);
  writeFileSync(
    path.join(WORK, "sea-config.json"),
    JSON.stringify({ main: "bundle.cjs", output: "sea-prep.blob", disableExperimentalSEAWarning: true }),
  );
  execFileSync(nodeExe, ["--experimental-sea-config", "sea-config.json"], { cwd: WORK, stdio: "inherit" });
  const exe = path.join(OUT, "AutoEditor.exe");
  copyFileSync(nodeExe, exe);
  run(`npx --yes postject "${exe}" NODE_SEA_BLOB "${path.join(WORK, "sea-prep.blob")}" --sentinel-fuse ${FUSE}`);

  console.log("[6/7] Assembling folder...");
  copyFileSync(path.join(ROOT, "server", "node_modules", "ffmpeg-static", "ffmpeg.exe"), path.join(OUT, "ffmpeg.exe"));
  copyFileSync(path.join(ROOT, "server", "assets", "caption.ttf"), path.join(OUT, "caption.ttf"));
  cpSync(path.join(ROOT, "out"), path.join(OUT, "out"), { recursive: true });
  // The exe is self-contained (self-locates assets, auto-opens the browser), so
  // no launcher scripts are shipped — users just run StoryToVideo.exe.
  copyFileSync(path.join(ROOT, "dist-assets", "READ ME FIRST.txt"), path.join(OUT, "READ ME FIRST.txt"));

  console.log("[7/7] Zipping...");
  mkdirSync(DIST, { recursive: true }); // keep dist/ — only overwrite our own zip
  const zip = path.join(DIST, "AutoEditor.zip");
  rmSync(zip, { force: true });
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
  ], { stdio: "inherit" });
  rmSync(STAGE, { recursive: true, force: true });

  console.log("\nDone. Share:  " + zip);
}

main().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
