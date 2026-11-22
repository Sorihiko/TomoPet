@echo off
chcp 65001 >nul
rem Double-click to start TomoPet (same as running "npm start" in this folder).
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies, this takes a few minutes...
  call npm install || goto :fail
)
call npm start
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Start failed. See the error above. If the Electron download failed, see README section 2 (mirror).
pause
