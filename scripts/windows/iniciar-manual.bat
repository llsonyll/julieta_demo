@echo off
REM Inicia el servidor en esta ventana (para pruebas). Cierre la ventana para detenerlo.
cd /d "%~dp0..\.."
if not exist node_modules call npm install --omit=dev
node --disable-warning=ExperimentalWarning server\index.js
pause
