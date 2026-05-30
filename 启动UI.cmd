@echo off
chcp 65001 > nul
echo ================================
echo   Codex Assistant 启动中
echo ================================
echo.

cd /d "%~dp0"

:: Clean up stale port file
if exist .ui-port del .ui-port

echo [1/2] 检测 Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js
  pause
  exit /b 1
)
echo Node.js 已安装: 
node --version

echo.
echo [2/2] 启动 UI 代理服务...
echo 关闭后台窗口可停止服务
echo.

:: Start node in background (no visible window)
start /B node ui-server.mjs

:: Wait for .ui-port file to appear
echo 等待服务就绪...
:waitloop
timeout /t 1 /nobreak >nul
if not exist .ui-port goto waitloop

:: Read the actual port
set /p ACTUAL_PORT=<.ui-port
echo 服务已就绪 (端口: %ACTUAL_PORT%)
start "" http://127.0.0.1:%ACTUAL_PORT%/

echo.
echo 请勿关闭此窗口，不影响服务运行...
pause >nul
