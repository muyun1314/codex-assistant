@echo off
setlocal enabledelayedexpansion

:: ============================================================
::  Codex Assistant Build Script
::  Usage: build.cmd [all|debug|release|portable]
::  Default: all
:: ============================================================

set "PROJECT_DIR=%~dp0"
cd /d "%PROJECT_DIR%"

:: Read version from tauri.conf.json
set "VERSION=unknown"
for /f "tokens=2 delims=:, " %%a in ('type src-tauri\tauri.conf.json ^| findstr "version"') do (
    if "!VERSION!"=="unknown" set "VERSION=%%~a"
)
set "VERSION=%VERSION:"=%"

echo.
echo ============================================================
echo   Codex Assistant v%VERSION% - Build Script
echo ============================================================
echo.

set "TARGET=%~1"
if "%TARGET%"=="" set "TARGET=all"

:: ---------- 1. Debug Build ----------
if "%TARGET%"=="all" goto :build_debug
if "%TARGET%"=="debug" goto :build_debug
goto :skip_debug

:build_debug
echo [1/3] Building Debug...
echo ------------------------------------------------------------
call npm run tauri:build:debug
if errorlevel 1 (
    echo.
    echo [ERROR] Debug build failed!
    goto :fail
)
echo [OK] Debug: src-tauri\target\debug\codex-assistant.exe
echo.
:skip_debug

:: ---------- 2. Release Build ----------
if "%TARGET%"=="all" goto :build_release
if "%TARGET%"=="release" goto :build_release
goto :skip_release

:build_release
echo [2/3] Building Release (installer)...
echo ------------------------------------------------------------
:: Pre-download WiX via mirror (with progress display)
echo   Checking WiX Toolset...
node wix-proxy.mjs
if errorlevel 1 (
    echo.
    echo [ERROR] WiX download failed!
    goto :fail
)
echo.
echo   Starting Tauri build (this may take several minutes)...
call npm run tauri:build
if errorlevel 1 (
    echo.
    echo [ERROR] Release build failed!
    goto :fail
)
echo [OK] Installer: src-tauri\target\release\bundle\
echo.
:skip_release

:: ---------- 3. Portable Build ----------
if "%TARGET%"=="all" goto :build_portable
if "%TARGET%"=="portable" goto :build_portable
goto :skip_portable

:build_portable
echo [3/3] Building Portable...
echo ------------------------------------------------------------

set "PORTABLE_DIR=dist\codex-assistant-v%VERSION%-portable"
if exist "%PORTABLE_DIR%" rmdir /s /q "%PORTABLE_DIR%"
mkdir "%PORTABLE_DIR%"

echo   [1/7] Copying exe...
if not exist "src-tauri\target\release\codex-assistant.exe" (
    echo   [ERROR] Release exe not found. Run: build.cmd release first
    goto :fail
)
copy /y "src-tauri\target\release\codex-assistant.exe" "%PORTABLE_DIR%\" >nul

echo   [2/7] Copying Node.js...
mkdir "%PORTABLE_DIR%\node" 2>nul
copy /y "src-tauri\resources\node\node.exe" "%PORTABLE_DIR%\node\" >nul

echo   [3/7] Copying frontend...
copy /y "ui-frontend.html" "%PORTABLE_DIR%\" >nul
copy /y "ui-frontend.css"  "%PORTABLE_DIR%\" >nul
copy /y "ui-frontend.js"   "%PORTABLE_DIR%\" >nul
copy /y "ui-favicon.ico"   "%PORTABLE_DIR%\" >nul

echo   [4/7] Copying backend...
copy /y "ui-server.mjs"    "%PORTABLE_DIR%\" >nul
copy /y "proxy.mjs"        "%PORTABLE_DIR%\" >nul

echo   [5/7] Copying modules...
mkdir "%PORTABLE_DIR%\src" 2>nul
copy /y "src\crypto-store.mjs" "%PORTABLE_DIR%\src\" >nul
copy /y "src\protocol.mjs"     "%PORTABLE_DIR%\src\" >nul
copy /y "src\rate-limit.mjs"   "%PORTABLE_DIR%\src\" >nul
copy /y "src\shared.mjs"       "%PORTABLE_DIR%\src\" >nul
copy /y "src\store.mjs"        "%PORTABLE_DIR%\src\" >nul
copy /y "src\streaming.mjs"    "%PORTABLE_DIR%\src\" >nul
copy /y "src\updater.mjs"      "%PORTABLE_DIR%\src\" >nul
copy /y "src\web-fetch.mjs"    "%PORTABLE_DIR%\src\" >nul

echo   [6/7] Copying docs...
copy /y "version.json"              "%PORTABLE_DIR%\" >nul
copy /y "env.example"               "%PORTABLE_DIR%\" >nul
copy /y "proxy-models.example.json" "%PORTABLE_DIR%\" >nul
copy /y "LICENSE"                   "%PORTABLE_DIR%\" >nul
copy /y "README.md"                 "%PORTABLE_DIR%\" >nul
copy /y "README.zh-CN.md"          "%PORTABLE_DIR%\" >nul

echo   [7/7] Creating launcher...
> "%PORTABLE_DIR%\Start.cmd" (
    echo @echo off
    echo cd /d "%%~dp0"
    echo start "" "codex-assistant.exe"
)
> "%PORTABLE_DIR%\README-PORTABLE.txt" (
    echo Codex Assistant v%VERSION% Portable
    echo ====================================
    echo.
    echo Double-click Start.cmd or codex-assistant.exe to launch.
    echo.
    echo Folders created at runtime (not in this package^):
    echo   user\  - your config and API keys
    echo   log\   - runtime logs
    echo.
    echo To uninstall: delete this entire folder.
)

echo.
echo   Compressing ZIP...
set "ZIP_NAME=dist\codex-assistant-v%VERSION%-portable.zip"
if exist "%ZIP_NAME%" del /f "%ZIP_NAME%"
powershell -NoProfile -Command "Compress-Archive -Path '%PORTABLE_DIR%\*' -DestinationPath '%ZIP_NAME%' -Force"
if errorlevel 1 (
    echo   [ERROR] ZIP compression failed!
    goto :fail
)

echo [OK] Portable:
echo   Folder: %PROJECT_DIR%%PORTABLE_DIR%
echo   ZIP:    %PROJECT_DIR%%ZIP_NAME%
echo.
:skip_portable

:: ---------- Done ----------
echo.
echo ============================================================
echo   Build complete!
echo ============================================================
if exist "src-tauri\target\debug\codex-assistant.exe" (
    echo   Debug:    %PROJECT_DIR%src-tauri\target\debug\codex-assistant.exe
)
if exist "src-tauri\target\release\bundle\nsis" (
    for %%f in ("src-tauri\target\release\bundle\nsis\*.exe") do echo   NSIS:     %PROJECT_DIR%%%f
)
if exist "src-tauri\target\release\bundle\msi" (
    for %%f in ("src-tauri\target\release\bundle\msi\*.msi") do echo   MSI:      %PROJECT_DIR%%%f
)
if exist "dist\codex-assistant-v%VERSION%-portable.zip" (
    echo   Portable: %PROJECT_DIR%dist\codex-assistant-v%VERSION%-portable.zip
)
echo ============================================================
echo.
goto :done

:fail
echo.
echo ============================================================
echo   BUILD FAILED - check errors above
echo ============================================================
echo.

:done
endlocal
pause
