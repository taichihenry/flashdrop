@echo off
chcp 65001 >nul
title 放行 FlashDrop 防火墙（需要管理员）

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo   需要管理员权限：右键本文件 -^> 以管理员身份运行
  echo.
  pause
  exit /b 1
)

set PORT=8686
set PORT_TLS=8687

echo.
echo   正在为端口 %PORT% 和 %PORT_TLS% 添加入站放行规则...
echo.

netsh advfirewall firewall delete rule name="FlashDrop HTTP" >nul 2>nul
netsh advfirewall firewall delete rule name="FlashDrop HTTPS" >nul 2>nul

netsh advfirewall firewall add rule name="FlashDrop HTTP" dir=in action=allow protocol=TCP localport=%PORT% profile=private
netsh advfirewall firewall add rule name="FlashDrop HTTPS" dir=in action=allow protocol=TCP localport=%PORT_TLS% profile=private

if errorlevel 1 (
  echo   [失败] 添加规则出错。
) else (
  echo   [完成] 已放行。手机现在应该能连上本机了。
  echo          规则只对「专用网络」生效，公网环境不会放行。
)

echo.
echo   如需撤销，在本文件里执行：
echo     netsh advfirewall firewall delete rule name="FlashDrop HTTP"
echo     netsh advfirewall firewall delete rule name="FlashDrop HTTPS"
echo.
pause
