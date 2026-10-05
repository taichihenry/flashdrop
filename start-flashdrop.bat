@echo off
chcp 65001 >nul
cd /d "%~dp0"
title FlashDrop 局域网互传

echo.
echo   正在启动 FlashDrop...
echo.

rem ---- 找 Node.js：先看 PATH，再试常见安装位置 ----
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

if not defined NODE_EXE (
  echo   [错误] 没有找到 Node.js。
  echo.
  echo   请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo   装完后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

rem ---- 首次运行自动装依赖 ----
if not exist "node_modules\ws" (
  echo   首次运行，正在安装依赖（约需 1 分钟）...
  call npm install --registry=https://registry.npmmirror.com --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败。请确认能访问网络后重试。
    echo.
    pause
    exit /b 1
  )
)

rem ---- 起服务 ----
"%NODE_EXE%" run.js %*

echo.
echo   服务已停止。
pause
