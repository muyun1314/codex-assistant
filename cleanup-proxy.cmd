@echo off
chcp 65001 >nul
echo ========================================
echo Codex Assistant - 清理残留进程
echo ========================================
echo.

echo [1/3] 查找占用端口 4000 的进程...
netstat -ano | findstr ":4000.*LISTENING"
if %errorlevel% neq 0 (
    echo 端口 4000 未被占用，无需清理
    goto :check_ui
)

echo.
echo [2/3] 终止占用端口 4000 的进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":4000.*LISTENING"') do (
    echo 终止进程 PID: %%a
    taskkill /F /PID %%a >nul 2>&1
    if !errorlevel! equ 0 (
        echo   √ 进程已终止
    ) else (
        echo   × 终止失败（可能需要管理员权限）
    )
)

:check_ui
echo.
echo [3/3] 查找并清理残留的 node.exe 进程...
tasklist /FI "IMAGENAME eq node.exe" /FI "STATUS eq RUNNING" >nul 2>&1
if %errorlevel% equ 0 (
    echo 发现运行中的 node.exe 进程：
    tasklist /FI "IMAGENAME eq node.exe" /FI "STATUS eq RUNNING" /FO TABLE
    echo.
    echo 注意：这些进程可能是其他应用程序的，请谨慎终止
    echo 如需终止所有 node.exe 进程，请手动执行：
    echo   taskkill /F /IM node.exe
) else (
    echo 未发现运行中的 node.exe 进程
)

echo.
echo ========================================
echo 清理完成！
echo ========================================
echo.
echo 现在可以重新启动开发版：
echo   双击 "启动开发版.cmd"
echo.
pause
