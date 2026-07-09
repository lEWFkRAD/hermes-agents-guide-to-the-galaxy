@echo off
REM Nightly retention: archive handwriting images older than 7 days.
REM Thumbnails keep working (the /img route also serves from data\archive).
"%LOCALAPPDATA%\hermes\node\node.exe" -e "fetch('http://127.0.0.1:8791/api/maintenance/archive?days=7',{method:'POST'}).then(r=>r.text()).then(t=>console.log(new Date().toISOString(),t)).catch(e=>{console.error(e);process.exit(1)})" >> "%~dp0archive.log" 2>&1
