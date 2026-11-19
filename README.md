# Sistema de Comandas — MVP

Sistema web para seguir las comandas de un restaurante en **red local (LAN)**.
Una PC hace de servidor (con la base de datos dentro) y los empleados lo usan
desde el **navegador de sus celulares**, conectados al WiFi del router.

- No necesita internet para funcionar (solo para instalarlo la primera vez).
- No se instala nada en los celulares.
- Las pantallas se actualizan **en tiempo real**: cocina recibe la comanda al instante con
  sonido, y el mozo recibe un aviso cuando su plato está listo.

---

## Inicio rápido (desde GitHub)

Requisitos: **Node.js 22.13 o superior** (se recomienda la versión LTS de <https://nodejs.org>) y **Git**.

```bash
git clone https://github.com/llsonyll/julieta_demo.git
cd julieta_demo
npm install
npm start
```

Abra <http://localhost:3000> en la PC e ingrese con `admin` / `admin123`.
La consola muestra también la dirección para los celulares (`http://192.168.x.x:3000`).
Para que arranque solo al encender la PC, vea la sección 2.

Para desarrollo (se reinicia al guardar cambios): `npm run dev`.

---

## 1. Funciones

| Módulo | Qué hace | Quién lo usa |
|---|---|---|
| **Usuarios y roles** | Crear, editar, desactivar y eliminar usuarios. Roles: `admin`, `mozo`, `caja`, `cocina`. | Admin |
| **Menú del día** | Platos que cambian cada día (con fecha). Botón **"Copiar de otro día"** para armar el menú rápido. | Admin |
| **Extras (carta fija)** | Platos principales permanentes, agrupados por categoría (Fondos, Bebidas…). | Admin |
| Mesa / para llevar | Cada plato se marca como disponible **para mesa**, **para llevar** o ambos. | Admin |
| Agotado | Marcar un plato como agotado (deja de poder pedirse). | Admin, Cocina |
| **Mesas** | Crear mesas y **asignarlas a un mozo**. Vista de mesas libres, ocupadas y con plato listo. | Admin (gestión), Mozo/Caja (vista) |
| **Comandas** | El mozo elige la mesa y los platos (cantidades y notas como "sin ají"). La caja puede tomar pedidos para llevar. | Mozo, Caja, Admin |
| **Etapas** | Generado → Enviado a cocina → En proceso → Esperando entrega → Entregado (y Cancelado). Cada cambio queda en el historial con hora y usuario. | Todos, según su rol |
| **Cobro** | Marcar la comanda como pagada (esto libera la mesa). | Caja, Admin |
| **Reporte del día** | Número de comandas, mesas atendidas, empleados en turno, total vendido y cobrado, ventas por empleado y por mesa, platos más vendidos, tiempo promedio de cocina. Se puede elegir otra fecha e imprimir. | Admin, Caja |
| **Turnos** | El turno se abre automáticamente al ingresar. El empleado lo cierra con "Finalizar turno y salir". | Todos |

### Quién puede cambiar cada etapa

| De → a | Quién |
|---|---|
| Generado → Enviado a cocina | Mozo, Caja |
| Enviado a cocina → En proceso | Cocina |
| En proceso → Esperando entrega | Cocina |
| Esperando entrega → Entregado | Mozo, Caja |
| Generado → Cancelado | Mozo, Caja |
| Enviado a cocina → Cancelado | Caja |
| Cualquier cambio | Admin |

Un mozo solo ve sus comandas y las de las mesas que tiene asignadas. Solo se pueden
editar las comandas que todavía no se enviaron a cocina (el admin puede editarlas hasta que se entreguen).

---

## 2. Instalación en la PC servidor (Windows)

1. Instale **Node.js 22 LTS o más reciente** (versión mínima 22.13) desde <https://nodejs.org>
   (opciones por defecto).
2. Copie la carpeta `comandas` a un lugar fijo, por ejemplo `C:\comandas`.
3. Edite `config.json` si quiere cambiar el nombre del restaurante, la moneda o el puerto:
   ```json
   { "puerto": 3000, "nombreRestaurante": "Mi Restaurante", "moneda": "S/", "diasRespaldo": 30 }
   ```
4. Abra `scripts\windows\`, haga **clic derecho en `instalar-inicio-automatico.bat` →
   "Ejecutar como administrador"**. El script:
   - instala las dependencias,
   - crea una tarea programada que **arranca el servidor al encender la PC**, aunque nadie
     inicie sesión en Windows, y lo reinicia si se cae,
   - abre el puerto en el Firewall de Windows,
   - desactiva la suspensión de la PC cuando está enchufada,
   - le muestra la dirección que deben abrir los celulares (por ejemplo `http://192.168.1.10:3000`).

Para probar sin instalar el arranque automático: doble clic en `scripts\windows\iniciar-manual.bat`.
Para quitar el arranque automático: `desinstalar-inicio-automatico.bat` (como administrador; los datos no se borran).

### Linux (alternativa)

```bash
sudo bash scripts/linux/instalar-servicio.sh
```

Crea un servicio `systemd` llamado `comandas` (`systemctl status comandas`, `journalctl -u comandas -f`).

---

## 3. Red local y celulares

1. **Fije la IP de la PC servidor**. En la configuración del router, busque *DHCP → Reserva de
   direcciones* (o "IP estática") y asígnele siempre la misma IP a la PC. Si no, la dirección
   puede cambiar al reiniciar el router y los celulares dejarán de conectarse.
2. Conecte la PC al router **por cable** si se puede (es más estable que el WiFi).
3. En cada celular: conéctese al WiFi del restaurante, abra el navegador en
   `http://IP-DE-LA-PC:3000` y use **"Agregar a pantalla de inicio"** para tenerlo como una app.
4. Si el router tiene una **red de invitados** para clientes, no la use para los empleados:
   esas redes suelen aislar los dispositivos y no dejan llegar a la PC.

---

## 4. Primer uso

Al iniciar por primera vez se crea la base de datos con datos de ejemplo:

| Usuario | Contraseña | Rol |
|---|---|---|
| `admin` | `admin123` | Administrador |
| `mozo1`, `mozo2` | `1234` | Mozo |
| `caja1` | `1234` | Caja |
| `cocina1` | `1234` | Cocina |

**Cambie estas contraseñas** (Gestión → Usuarios) y reemplace las mesas y platos de ejemplo
por los suyos antes de usarlo en serio.

**Rutina diaria sugerida:** el admin entra a *Gestión → Menú del día*, pulsa
*"Copiar de otro día"* (o agrega los platos nuevos) y ajusta precios o marca agotados.

---

## 5. Datos y respaldos

- La base de datos es un solo archivo: `data/comandas.db` (SQLite).
- Cada día se guarda automáticamente una copia en `data/respaldos/` (se conservan los últimos 30 días).
- Se recomienda copiar de vez en cuando la carpeta `data/respaldos` a un USB o a la nube.
- Para restaurar: detenga el servidor y reemplace `data/comandas.db` por el respaldo
  (borre también los archivos `comandas.db-wal` y `comandas.db-shm` si existen).
- El registro del servidor está en `logs/servidor.log` (Windows).

---

## 6. Estructura técnica

```
comandas/
├── config.json            configuración (nombre, moneda, puerto)
├── server/
│   ├── index.js           API REST + eventos en tiempo real (SSE) + archivos estáticos
│   └── db.js              esquema SQLite, datos iniciales y respaldos
├── public/                app web para celulares (HTML/CSS/JS sin frameworks)
├── scripts/windows/       arranque automático en Windows
├── scripts/linux/         servicio systemd
└── data/                  base de datos y respaldos (se crea sola)
```

- **Node.js + Express**, base de datos **SQLite** integrada en Node (`node:sqlite`), sin
  motor de base de datos aparte.
- Contraseñas guardadas con hash `scrypt`; las sesiones usan una cookie `HttpOnly`.
- Tablas: `usuarios`, `sesiones`, `turnos`, `mesas`, `productos` (tipo `menu` con fecha o `extra`),
  `comandas`, `comanda_items`, `comanda_historial`.

### Limitaciones de este MVP (siguientes pasos posibles)

- Usa HTTP sin cifrar: está pensado solo para la red interna del restaurante.
- No imprime tickets en una impresora térmica, no emite boletas ni facturas, y no maneja
  medios de pago (solo marca "pagada").
- El sonido de aviso necesita que el celular tenga la página abierta y la pantalla encendida
  (los navegadores no permiten notificaciones push sin HTTPS).
- Sin control de inventario ni división de cuenta.
