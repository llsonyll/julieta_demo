@echo off
REM Inicia el servidor de comandas y lo reinicia si se detiene.
REM Lo ejecuta la tarea programada "ComandasRestaurante" al encender la PC.
cd /d "%~dp0..\.."
set "PATH=%PATH%;C:\Program Files\nodejs"
if not exist logs mkdir logs
:bucle
echo [%date% %time%] Iniciando servidor >> logs\servidor.log
node --disable-warning=ExperimentalWarning server\index.js >> logs\servidor.log 2>&1
echo [%date% %time%] El servidor se detuvo. Reinicio en 5 segundos >> logs\servidor.log
timeout /t 5 /nobreak > nul
goto bucle
