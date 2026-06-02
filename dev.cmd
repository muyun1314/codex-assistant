@echo off
cd /d "%~dp0"
echo Starting Codex Assistant dev build...
echo.
npm run tauri:dev 2>&1
echo.
echo Exit code: %errorlevel%
if %errorlevel% neq 0 (
    echo.
    echo Build failed! Check the error above.
)
pause
