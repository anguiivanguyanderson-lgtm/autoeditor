@echo off
setlocal
REM Stops the Story-to-Video server by killing whatever is listening on port 4000.
set "PORT=4000"
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :%PORT% ^| findstr LISTENING') do (
  echo Stopping server ^(PID %%p^)...
  taskkill /F /PID %%p >nul 2>&1
  set "FOUND=1"
)
if defined FOUND (
  echo Story-to-Video stopped.
) else (
  echo Nothing is running on port %PORT%.
)
timeout /t 2 >nul
