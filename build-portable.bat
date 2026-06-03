@echo off
setlocal

set VERSION=1.2.4
set OUTPUT_DIR=F:\WorkSpace\研发成品\Codex-Assistant-v%VERSION%-portable
set RELEASE_DIR=F:\WorkSpace\codex-assistant\src-tauri\target\release
set RESOURCES_DIR=F:\WorkSpace\codex-assistant\src-tauri\resources

echo Creating portable package v%VERSION%...

REM 创建输出目录
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"
mkdir "%OUTPUT_DIR%"

REM 复制主程序
copy "%RELEASE_DIR%\codex-assistant.exe" "%OUTPUT_DIR%\"
if errorlevel 1 (
    echo ERROR: Failed to copy codex-assistant.exe
    exit /b 1
)

REM 复制资源文件
mkdir "%OUTPUT_DIR%\resources"
xcopy /E /I /Y "%RESOURCES_DIR%\*" "%OUTPUT_DIR%\resources\"

REM 复制其他必要文件
copy "F:\WorkSpace\codex-assistant\version.json" "%OUTPUT_DIR%\"
copy "F:\WorkSpace\codex-assistant\LICENSE" "%OUTPUT_DIR%\"
copy "F:\WorkSpace\codex-assistant\CHANGELOG-v1.2.4.md" "%OUTPUT_DIR%\"

REM 创建启动脚本
echo @echo off > "%OUTPUT_DIR%\启动 Codex Assistant.bat"
echo start codex-assistant.exe >> "%OUTPUT_DIR%\启动 Codex Assistant.bat"

echo.
echo Portable package created: %OUTPUT_DIR%
echo.

REM 列出文件
dir "%OUTPUT_DIR%"

endlocal
