@echo off
REM Hermes Diary bridge — auto-restart wrapper for the scheduled task.
REM Keeps the bridge alive; if node exits for any reason, wait and relaunch.
cd /d "%~dp0"
:loop
"%LOCALAPPDATA%\hermes\node\node.exe" server.mjs >> "%~dp0server.log" 2>> "%~dp0server.err.log"
timeout /t 3 /nobreak >nul
goto loop
