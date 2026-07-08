@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est introuvable. Installe Node.js 20 ou plus recent depuis https://nodejs.org
  echo puis relance ce fichier.
  pause
  exit /b 1
)

echo Demarrage du serveur EP Bank Organizer...
echo Le navigateur va s'ouvrir automatiquement. Laisse cette fenetre ouverte.
echo Pour arreter : ferme cette fenetre ou appuie sur Ctrl+C.
echo.
node tools\server.mjs
pause
