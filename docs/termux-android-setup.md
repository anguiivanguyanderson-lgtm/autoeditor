# AutoEditor on Android (Termux) — Setup Reference

Run AutoEditor entirely on an Android phone using **Termux**. Rendering happens
**on the device** with Termux's own Node + ffmpeg — nothing is uploaded, no cloud,
no app store.

The distributable is **`AutoEditor-android.zip`** (built on a dev machine with
`node build-dist-termux.mjs`). It contains only `bundle.cjs` (the server), the
`out/` UI, `caption.ttf`, `start.sh`, and a README — **no binaries**, so it's tiny
(~1 MB). Node and ffmpeg are installed by `start.sh` on first run.

---

## One-time setup (per phone)

### 1. Install Termux (from the Google Play Store)
Install **Termux** from the **Google Play Store**.

### 2. Grant Termux access to your files (storage access)
Open Termux and run:

```bash
termux-setup-storage
```

Tap **Allow** on the Android permission dialog. This creates `~/storage/…`
inside Termux, symlinked to your phone's shared storage:

- `~/storage/downloads` → the phone's **Download** folder
- `~/storage/shared`   → internal shared storage root (visible to Gallery/Files)

This step is what lets Termux read the zip from Downloads and **save finished
videos where your Gallery/Files app can see them**.

### 3. Install `unzip` (if it's missing)
```bash
pkg install -y unzip
```

---

## Getting the app onto the phone and running it

### 4. Put `AutoEditor-android.zip` in Downloads
Copy/transfer `AutoEditor-android.zip` to the phone's **Download** folder (WhatsApp,
a cable, cloud drive — whatever's easiest).

### 5. Unzip it
```bash
cd ~/storage/downloads
unzip AutoEditor-android.zip
cd AutoEditor-android
```

### 6. Start it
```bash
bash start.sh
```

**On the first run**, `start.sh` automatically:
- installs Node.js + ffmpeg if missing (`pkg update` + `pkg install -y nodejs ffmpeg`) — needs internet, one-time,
- fixes file permissions (`chmod -R u+rwX .`) — Windows-made zips drop the Unix
  permission bits, which otherwise causes `EACCES` errors serving the UI,
- picks the output folder (shared storage if available),
- takes a **wake-lock** so long renders survive the screen turning off,
- starts the server on **port 4000**.

Every run after that just starts the server instantly.

### 7. Open the editor
In **Chrome or Firefox on the same phone**, go to:

```
http://localhost:4000
```

Build your timeline and render, exactly like the desktop app.

To **stop**: return to Termux and press **Ctrl+C**.

---

## Important on-device notes

### Add images via "Files", not the Gallery
Android's **Gallery / Google Photos** picker renames files (it hands the browser a
MediaStore id, not `0-03.png`), which breaks the timestamp naming. On phones the
app is set to open the **Files / Documents** picker instead, which keeps the real
filename. If a chooser ever opens Photos, back out and pick **Files**.

### Rendering runs in the background — you can close the browser
The render runs in the Termux server, not the browser. After you tap **Render**
you can **close the browser or lock the screen** — it keeps rendering.

The finished MP4 is **auto-saved** to:

```
~/storage/shared/AutoEditor/        →  /storage/emulated/0/AutoEditor/
```

(falls back to `~/AutoEditor-output` if you skipped `termux-setup-storage`). It
shows up in your **Gallery/Files** as `autoeditor-<timestamp>-<id>.mp4`.

### Seeing progress after the browser is closed
Two ways:
1. **Termux console** — switch to Termux; it prints `Rendering… 5% / 10% / …` and
   `Saved video to …` when done.
2. **`/status` endpoint** — open `http://localhost:4000/status` (or
   `curl localhost:4000/status`) → `[{"status":"running","percent":45}]`.

### Reopening the browser reconnects
If you close the tab and reopen `http://localhost:4000` while a render is still
running, a banner reconnects to it and shows live progress + a Download when done.

### One render at a time
A second render is refused while one is running (phones can't do two at once) —
wait for the current one to finish, or Cancel it first.

### The phone stays usable during a render
Renders can be CPU-heavy (transitions and zoom especially). To keep the phone
responsive, `start.sh` runs ffmpeg at **low priority** (`RENDER_NICE=15`) and caps
it to **about half the cores** (`RENDER_THREADS`) so it won't peg the CPU or
overheat. Foreground apps always get CPU first, so scrolling/typing stays smooth;
the render just uses spare capacity (fastest when the screen is off).

Tune it before running if you like:
```bash
RENDER_THREADS=0 RENDER_NICE=0 bash start.sh   # full speed (may make the phone sluggish)
RENDER_THREADS=2 RENDER_NICE=19 bash start.sh  # gentlest (slowest, phone stays snappy)
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EACCES: permission denied … out/…` | Old zip without the permission self-heal. Run `chmod -R u+rwX .` in the folder, then `bash start.sh`. Newer `start.sh` does this automatically. |
| Image timestamp shows a huge number (e.g. `10000689:15`) | You added it via **Gallery/Photos**. Re-add via **Files**. |
| `node not found` / `ffmpeg not found` | Needs internet on first run. Or install manually: `pkg install -y nodejs ffmpeg`. |
| `unzip: command not found` | `pkg install -y unzip`. |
| Video didn't save to Gallery | Run `termux-setup-storage` once, then it saves to `~/storage/shared/AutoEditor`. |

---

## Quick reference — the whole flow

```bash
# one-time
# (install Termux from the Google Play Store first)
termux-setup-storage          # tap Allow
pkg install -y unzip

# each app version
cd ~/storage/downloads
unzip AutoEditor-android.zip
cd AutoEditor-android
bash start.sh                 # first run installs node+ffmpeg
# → open http://localhost:4000 in the browser
```
