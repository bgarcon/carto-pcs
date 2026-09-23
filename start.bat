@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Node.js n'est pas installe sur cet ordinateur.
    echo Telechargez-le sur https://nodejs.org puis relancez ce fichier.
    pause
    exit /b 1
)
if not exist "node_modules" (
    echo Installation des dependances...
    call npm install
)
node server.js
pause
