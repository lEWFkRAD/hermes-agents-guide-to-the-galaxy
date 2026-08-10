@echo off
REM Hermes Diary bridge — auto-restart wrapper for the scheduled task.
REM Keeps the bridge alive; if node exits for any reason, wait and relaunch.
cd /d "%~dp0"
REM Keep the caller's profile-specific environment intact. Reading shared HKCU
REM variables here can overwrite one Hermes profile with another profile's token.
if defined HERMES_HOME (
  set "HERMES_NOTEBOOK_LOG_DIR=%HERMES_HOME%\notebook\logs"
) else (
  set "HERMES_NOTEBOOK_LOG_DIR=%~dp0"
)
if not exist "%HERMES_NOTEBOOK_LOG_DIR%" mkdir "%HERMES_NOTEBOOK_LOG_DIR%"
:loop
"%LOCALAPPDATA%\hermes\node\node.exe" server.mjs >> "%HERMES_NOTEBOOK_LOG_DIR%\server.log" 2>> "%HERMES_NOTEBOOK_LOG_DIR%\server.err.log"
timeout /t 3 /nobreak >nul
goto loop
