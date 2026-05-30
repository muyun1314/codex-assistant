@echo off
REM ============================================================
REM Codex Assistant — Release Script (Windows)
REM Builds and publishes a new release to GitHub
REM ============================================================

setlocal enabledelayedexpansion

echo Codex Assistant Release Script
echo ================================
echo.

REM Check if gh CLI is installed
where gh >nul 2>&1
if errorlevel 1 (
    echo Error: GitHub CLI ^(gh^) is not installed.
    echo Install it from: https://cli.github.com/
    pause
    exit /b 1
)

REM Check if authenticated
gh auth status >nul 2>&1
if errorlevel 1 (
    echo Error: Not authenticated with GitHub CLI.
    echo Run: gh auth login
    pause
    exit /b 1
)

REM Read current version
if not exist "version.json" (
    echo Error: version.json not found
    pause
    exit /b 1
)

for /f "tokens=2 delims=:, " %%a in ('findstr /C:"version" version.json') do (
    set CURRENT_VERSION=%%~a
)
set CURRENT_VERSION=%CURRENT_VERSION:"=%
echo Current version: v%CURRENT_VERSION%
echo.

REM Ask for new version
set /p NEW_VERSION="Enter new version (e.g., 1.2.0): "

if "%NEW_VERSION%"=="" (
    echo Error: Version cannot be empty
    pause
    exit /b 1
)

REM Ask for changelog
echo.
echo Enter changelog ^(press Enter to use default^):
set /p CHANGELOG="> "
if "%CHANGELOG%"=="" set CHANGELOG=Release v%NEW_VERSION%

REM Update version.json
echo.
echo Updating version.json...

REM Get current build number
for /f "tokens=2 delims=:, " %%a in ('findstr /C:"build" version.json') do (
    set /a BUILD=%%a
)
set /a NEW_BUILD=BUILD+1

(
echo {
echo   "version": "%NEW_VERSION%",
echo   "build": %NEW_BUILD%,
echo   "releasedAt": "%date:~0,4%-%date:~5,2%-%date:~8,2%",
echo   "changelog": "%CHANGELOG%"
echo }
) > version.json

echo ✓ Updated version.json

REM Create release archive
echo.
echo Creating release archive...

set ARCHIVE_NAME=codex-assistant-v%NEW_VERSION%.zip

REM Clean up previous release temp
if exist "release-temp" rmdir /s /q "release-temp"
mkdir "release-temp"

REM Copy files using xcopy
xcopy /E /I /Q /H /Y "." "release-temp\codex-assistant\" >nul

REM Remove dev files from release
if exist "release-temp\codex-assistant\.git" rmdir /s /q "release-temp\codex-assistant\.git"
if exist "release-temp\codex-assistant\node_modules" rmdir /s /q "release-temp\codex-assistant\node_modules"
if exist "release-temp\codex-assistant\release-temp" rmdir /s /q "release-temp\codex-assistant\release-temp"
if exist "release-temp\codex-assistant\user" rmdir /s /q "release-temp\codex-assistant\user"
if exist "release-temp\codex-assistant\tests" rmdir /s /q "release-temp\codex-assistant\tests"
if exist "release-temp\codex-assistant\.claude" rmdir /s /q "release-temp\codex-assistant\.claude"

REM Create zip using PowerShell
powershell -Command "Compress-Archive -Path 'release-temp\codex-assistant' -DestinationPath '%ARCHIVE_NAME%' -Force"

echo ✓ Created %ARCHIVE_NAME%

REM Clean up release temp
rmdir /s /q "release-temp"

REM Commit version changes
echo.
echo Committing version changes...
git add version.json
git commit -m "release: v%NEW_VERSION%"

REM Create git tag
echo.
echo Creating git tag...
git tag -a "v%NEW_VERSION%" -m "Release v%NEW_VERSION%"

REM Push changes
echo.
echo Pushing changes...
git push origin main
git push origin "v%NEW_VERSION%"

REM Create GitHub Release
echo.
echo Creating GitHub Release...
gh release create "v%NEW_VERSION%" --title "v%NEW_VERSION%" --notes "%CHANGELOG%" "%ARCHIVE_NAME%"

echo.
echo ✓ Release v%NEW_VERSION% published successfully!
echo.
echo Release URL:
gh release view "v%NEW_VERSION%" --json url -q ".url"

REM Clean up local archive
del /f "%ARCHIVE_NAME%"

echo.
echo Done!
pause
