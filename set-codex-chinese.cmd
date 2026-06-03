@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ============================================
echo   设置 Codex 桌面版为中文界面
echo ============================================
echo.

:: 检查 Codex 是否在运行
tasklist /fi "imagename eq Codex.exe" 2>nul | findstr /i "Codex.exe" >nul
if not errorlevel 1 (
    echo [提示] Codex 正在运行，正在关闭...
    taskkill /f /im Codex.exe >nul 2>&1
    timeout /t 2 /nobreak >nul
)

set "PREFS=%APPDATA%\Codex\web\Codex\Default\Preferences"

if not exist "%PREFS%" (
    echo [错误] 未找到 Codex 配置文件: %PREFS%
    echo 请先安装并运行一次 Codex 桌面版
    pause
    exit /b 1
)

echo [1/2] 修改语言配置为中文...
powershell -NoProfile -Command ^
  "$p = '%PREFS%';" ^
  "$j = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json;" ^
  "if (-not $j.intl) { $j | Add-Member -NotePropertyName 'intl' -NotePropertyValue @{} };" ^
  "$j.intl.selected_languages = 'zh-CN,zh';" ^
  "$j | ConvertTo-Json -Depth 100 -Compress | Set-Content $p -Encoding UTF8 -NoNewline;" ^
  "Write-Host '  语言已设置为: zh-CN'"

echo [2/2] 启动 Codex 验证...
timeout /t 1 /nobreak >nul
start "" "C:\Users\DQ\.chatclaw\native\bin\codex.exe"

echo.
echo 完成！请查看 Codex 界面是否已变为中文。
echo 如果没有变化，请手动关闭 Codex 后重新运行此脚本。
echo.
pause
