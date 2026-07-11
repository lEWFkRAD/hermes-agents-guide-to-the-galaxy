@echo off
REM Hermes Diary bridge — auto-restart wrapper for the scheduled task.
REM Keeps the bridge alive; if node exits for any reason, wait and relaunch.
cd /d "%~dp0"
REM Refresh persisted user variables on every launch. A long-running desktop app
REM can otherwise spawn this wrapper with an environment snapshot from hours ago.
for %%K in (DIARY_AUTH_TOKEN DIARY_REMOTE_KEY DIARY_TRUSTED_IPS DIARY_LIVE_WRITE_TOKEN KINDLE_INGEST_TOKEN KINDLE_USER KINDLE_ADAPTER_URL) do (
  for /f "tokens=2,*" %%A in ('reg query HKCU\Environment /v %%K 2^>nul') do set "%%K=%%B"
)
:loop
"%LOCALAPPDATA%\hermes\node\node.exe" server.mjs >> "%~dp0server.log" 2>> "%~dp0server.err.log"
timeout /t 3 /nobreak >nul
goto loop
