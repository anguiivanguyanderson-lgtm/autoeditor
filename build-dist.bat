@echo off
REM Build the shareable zero-install Windows distributable (single compiled exe).
REM Needs Node + npm + internet on this dev machine.
cd /d "%~dp0"
node build-dist.mjs %*
