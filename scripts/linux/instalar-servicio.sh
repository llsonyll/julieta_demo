#!/usr/bin/env bash
# Instala el sistema de comandas como servicio systemd (arranca al encender la PC).
# Uso:  sudo bash scripts/linux/instalar-servicio.sh
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "Ejecute con sudo"; exit 1; fi
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
USUARIO="${SUDO_USER:-root}"
NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "Node.js no está instalado (se requiere v22.13 o superior)"; exit 1; }

cd "$DIR"
sudo -u "$USUARIO" npm install --omit=dev

cat > /etc/systemd/system/comandas.service <<UNIT
[Unit]
Description=Sistema de comandas del restaurante
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USUARIO
WorkingDirectory=$DIR
ExecStart=$NODE --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now comandas.service
PUERTO="$(node -p "require('$DIR/config.json').puerto || 3000")"
if command -v ufw >/dev/null && ufw status | grep -q active; then ufw allow "$PUERTO"/tcp; fi
echo
echo "Listo. Estado: systemctl status comandas   |   Registro: journalctl -u comandas -f"
for ip in $(hostname -I); do echo "Abrir en celulares: http://$ip:$PUERTO"; done
