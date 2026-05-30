@echo off
cd /d "%~dp0"
echo Starting Codex Assistant...
echo.

REM Check if user folder exists, create if not
if not exist "user" (
    echo Creating user folder...
    mkdir user
    echo.
    echo Please copy env.example to user/.env and fill in your API keys.
    echo Then run this script again.
    pause
    exit /b
)

REM Check if user/.env exists
if not exist "user\.env" (
    echo Error: user/.env not found!
    echo.
    echo Please copy env.example to user/.env and fill in your API keys.
    echo Then run this script again.
    pause
    exit /b
)

node --env-file=user/.env proxy.mjs
pause
