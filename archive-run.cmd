@echo off
REM Nightly retention: archive handwriting images older than 7 days.
REM Thumbnails keep working (the /img route also serves from data\archive).
if defined HERMES_HOME (
  set "HERMES_NOTEBOOK_LOG_DIR=%HERMES_HOME%\notebook\logs"
) else (
  set "HERMES_NOTEBOOK_LOG_DIR=%~dp0"
)
if not exist "%HERMES_NOTEBOOK_LOG_DIR%" mkdir "%HERMES_NOTEBOOK_LOG_DIR%"
"%LOCALAPPDATA%\hermes\node\node.exe" -e "const port=process.env.DIARY_PORT||'8791';const diary=process.env.DIARY_AUTH_TOKEN||'';const remote=process.env.DIARY_REMOTE_KEY||'';if(!diary&&!remote)throw new Error('DIARY_AUTH_TOKEN or DIARY_REMOTE_KEY is required');const headers=diary?{'x-diary-auth':diary}:{'x-diary-remote-key':remote};fetch('http://127.0.0.1:'+port+'/api/maintenance/archive?days=7',{method:'POST',headers}).then(async r=>{const t=await r.text();if(!r.ok)throw new Error('archive request failed: '+r.status);console.log(new Date().toISOString(),t)}).catch(e=>{console.error(e.message);process.exit(1)})" >> "%HERMES_NOTEBOOK_LOG_DIR%\archive.log" 2>&1
