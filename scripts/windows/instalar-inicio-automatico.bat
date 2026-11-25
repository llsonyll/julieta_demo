@echo off
REM ==========================================================
REM  Instala el sistema de comandas para que arranque solo
REM  al encender la PC (aunque nadie inicie sesion en Windows).
REM  Clic derecho > "Ejecutar como administrador"
REM ==========================================================
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: haga clic derecho en este archivo y elija "Ejecutar como administrador".
  echo.
  pause
  exit /b 1
)
cd /d "%~dp0..\.."
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js no esta instalado. Descargue la version LTS de https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo [1/5] Instalando dependencias...
call npm install --omit=dev
if errorlevel 1 (
  echo  ERROR al instalar dependencias. Revise la conexion a internet.
  pause
  exit /b 1
)

REM Puerto final: config.json combinado con config.local.json (si existe)
set "PUERTO="
for /f "delims=" %%p in ('node server\config.js puerto') do set "PUERTO=%%p"
if not defined PUERTO (
  echo.
  echo  ERROR: no se pudo leer la configuracion. Corrija config.json / config.local.json
  echo  segun el mensaje de arriba y vuelva a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

echo [2/5] Creando tarea programada al inicio de Windows...
schtasks /Create /F /TN "ComandasRestaurante" /SC ONSTART /RU SYSTEM /RL HIGHEST /DELAY 0000:20 /TR "\"%~dp0iniciar-servidor.bat\""

echo [3/5] Abriendo el puerto %PUERTO% en el Firewall de Windows...
netsh advfirewall firewall delete rule name="Comandas Restaurante" >nul 2>&1
netsh advfirewall firewall add rule name="Comandas Restaurante" dir=in action=allow protocol=TCP localport=%PUERTO% profile=any

echo [4/5] Evitando que la PC entre en suspension (con corriente)...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

echo [5/5] Iniciando el servidor ahora...
schtasks /Run /TN "ComandasRestaurante"

echo.
echo  LISTO. El sistema arrancara solo cada vez que se encienda la PC.
echo  Abra en los celulares (conectados al WiFi del restaurante):
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /i "IPv4"') do echo     http:%%i:%PUERTO%
echo.
echo  Registro del servidor: %cd%\logs\servidor.log
echo.
pause
