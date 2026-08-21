@echo off
setlocal
cd /d "%~dp0"

REM Prefer a bundled portable Node (runtime\node.exe); fall back to system Node.
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

REM First run: install backend dependencies (needs npm on PATH; skipped in the
REM prebuilt distributable where server\node_modules already ships).
if not exist "server\node_modules" (
  echo Installing render engine dependencies...
  pushd server
  call npm install
  popd
)

REM First run: build the app UI (skipped in the prebuilt distributable where
REM out\index.html already ships).
if not exist "out\index.html" (
  echo Building the app ^(first run only^)...
  if not exist "node_modules" ( call npm install )
  call npm run build
)

echo.
echo ============================================================
echo   Story-to-Video is starting at http://localhost:4000
echo   Your browser will open automatically.
echo.
echo   To STOP the app: close this window, or press Ctrl+C.
echo   KEEP THIS WINDOW OPEN while you use the app.
echo ============================================================
echo.

REM Run the server in THIS window (foreground) so the window stays open and
REM closing it stops the app. The server opens the browser itself once ready.
set "OPEN_BROWSER=1"
"%NODE%" server\index.js
