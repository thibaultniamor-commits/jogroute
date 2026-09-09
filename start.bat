@echo off
REM Lance JogRoute : serveur local + navigateur
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python introuvable : ouverture directe de index.html
  start "" "index.html"
  exit /b
)
start "" http://localhost:8765/index.html
python -m http.server 8765
