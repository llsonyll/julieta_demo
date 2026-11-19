@echo off
REM Quita el arranque automatico (no borra los datos). Ejecutar como administrador.
net session >nul 2>&1
if errorlevel 1 (
  echo  Ejecute este archivo como administrador.
  pause
  exit /b 1
)
schtasks /End /TN "ComandasRestaurante" >nul 2>&1
schtasks /Delete /F /TN "ComandasRestaurante"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server\index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
netsh advfirewall firewall delete rule name="Comandas Restaurante"
echo  Arranque automatico desinstalado. Los datos siguen en la carpeta data\
pause
