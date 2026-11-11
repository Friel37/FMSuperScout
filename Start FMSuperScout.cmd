@echo off
cd /d "%~dp0"
if not exist "dist\runtime\node.exe" (
 echo Run tools\setup-local.ps1 -NodeExe path\to\node.exe first.
 pause
 exit /b 1
)
start "" http://localhost:8765
"dist\runtime\node.exe" app\server.js
pause
