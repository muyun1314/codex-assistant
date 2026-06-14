@echo off
title Codex Assistant - Environment Checker
setlocal enabledelayedexpansion

echo.
echo   ===============================================
echo     Codex Assistant - Environment Checker
echo              v1.3.x Dependencies
echo   ===============================================
echo.
echo   Checking system...

set MISSING=0
set WV_OK=0
set VC_OK=0

echo.
echo   [1/2] Microsoft Edge WebView2 Runtime...
set WK=HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}
reg query "%WK%" >nul 2>&1
if !errorlevel! equ 0 (
    for /f "tokens=2,*" %%a in ('reg query "%WK%" /v pv 2^>nul ^| findstr "pv"') do set WV_VER=%%b
    if defined WV_VER (
        echo     [OK] WebView2 installed
        set WV_OK=1
    ) else (
        echo     [MISS] WebView2 NOT found
        set /a MISSING+=1
    )
) else (
    echo     [MISS] WebView2 NOT found
    set /a MISSING+=1
)

echo.
echo   [2/2] VC++ 2015-2022 Redist (x64)...
set VK=HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64
reg query "%VK%" >nul 2>&1
if !errorlevel! equ 0 (
    for /f "tokens=2,*" %%a in ('reg query "%VK%" /v Version 2^>nul ^| findstr "Version"') do set VC_VER=%%b
    if defined VC_VER (
        echo     [OK] VC++ installed
        set VC_OK=1
    ) else (
        echo     [MISS] VC++ NOT found
        set /a MISSING+=1
    )
) else (
    echo     [MISS] VC++ NOT found
    set /a MISSING+=1
)

echo.
echo   ===============================================
echo   Missing: !MISSING! dependencies
echo   ===============================================
echo.

if !MISSING! equ 0 (
    echo   [OK] All dependencies ready! You can run the software now.
    echo.
    echo   Press any key to exit...
    pause >nul
    exit /b 0
)

echo   Missing components:
echo.
if !WV_OK! equ 0 (
    echo   - WebView2 Runtime (UI engine)
    echo     Download: https://developer.microsoft.com/microsoft-edge/webview2/
    echo.
)
if !VC_OK! equ 0 (
    echo   - VC++ 2015-2022 x64 Redistributable
    echo     Download: https://aka.ms/vs/17/release/vc_redist.x64.exe
    echo.
)

echo   -----------------------------------------------
echo   Y = Auto-install all     N = Skip
echo   1 = WebView2 only        2 = VC++ only
echo   -----------------------------------------------
echo.

set /p CHOICE=Choose [Y/N/1/2]: 

if /i "!CHOICE!"=="N" (
    echo.
    echo   Please install manually, then try again.
    pause
    exit /b 0
)

set DL=%TEMP%\ca-deps
if not exist "!DL!" mkdir "!DL!"

if /i "!CHOICE!"=="Y" goto WV
if /i "!CHOICE!"=="1" goto WV
if /i "!CHOICE!"=="2" goto VCR
goto END

:WV
if !WV_OK! equ 1 (
    if /i "!CHOICE!"=="1" goto END
    goto VCR
)
echo.
echo   [Installing] WebView2 Runtime... (1-3 min)
set WS=!DL!\WV2Setup.exe
powershell -NoProfile -Command "$wc=New-Object Net.WebClient;$wc.DownloadFile('https://go.microsoft.com/fwlink/p/?LinkId=2124703','!WS!')"
if not exist "!WS!" (
    echo   [FAIL] Download failed. Please install manually.
    goto VCR
)
start /wait "" "!WS!" /silent /install
echo   [OK] WebView2 installed.
if /i "!CHOICE!"=="1" goto END

:VCR
if !VC_OK! equ 1 goto END
echo.
echo   [Installing] VC++ Redist... (1-2 min)
set VS=!DL!\vc_x64.exe
powershell -NoProfile -Command "$wc=New-Object Net.WebClient;$wc.DownloadFile('https://aka.ms/vs/17/release/vc_redist.x64.exe','!VS!')"
if not exist "!VS!" (
    echo   [FAIL] Download failed. Please install manually.
    goto END
)
start /wait "" "!VS!" /install /quiet /norestart
echo   [OK] VC++ installed.

:END
echo.
echo   ===============================================
echo   Done! Restart PC recommended before running.
echo   ===============================================
pause >nul
exit /b 0
