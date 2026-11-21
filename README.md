# Sistema de Comandas — MVP

Sistema web para seguir las comandas de un restaurante en **red local (LAN)**.
Una PC hace de servidor (con la base de datos dentro) y los empleados lo usan
desde el **navegador de sus celulares**, conectados al WiFi del router.

- No necesita internet para funcionar (solo para instalarlo la primera vez).
- No se instala nada en los celulares.
- Las pantallas se actualizan **en tiempo real**.
- Cocina trabaja con **tickets impresos**: al enviar una comanda se genera su ticket (PDF de 80 mm).
- Al cobrar se genera un **comprobante de pago en PDF** (80 mm) listo para imprimir.

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
| **Platos** | Catálogo de platos que se crea una sola vez. Cada plato es **Menú del día** (sale los días que se marque) o **Extra** (carta fija). Tiene precio, una **guarnición por defecto** (ej: arroz) y puede llevar **una guarnición a elección**. Se indica si es para mesa, para llevar o ambos. | Admin |
| **Guarniciones** | Lista de guarniciones (arroz, papas, picante de lisas, kapchi…). No cambian el precio del plato. | Admin |
| **Carta del día** | Pantalla diaria del admin: marcar qué platos de menú salen y qué guarniciones a elección se ofrecen ese día. Botón **"Copiar carta del día anterior"**. | Admin |
| Agotado | Marcar un plato como agotado (deja de poder pedirse). | Admin, Caja, Cocina |
| **Mesas** | Cada mesa tiene un mozo asignado, pero **cualquier mozo puede atender cualquier mesa**. Vista de mesas libres y ocupadas con su consumo. | Admin (gestión), todos (vista) |
| **Comandas** | El mozo elige la mesa y los platos. En cada plato puede **cambiar o quitar la guarnición por defecto**, elegir la **guarnición a elección del día**, la cantidad y una nota. La caja puede tomar pedidos para llevar. | Mozo, Caja, Admin |
| **Etapas** | Generado → **En cocina** (se genera el ticket) → **Entregado** (lo marca el mozo), y Cancelado. Cada cambio queda en el historial con hora y usuario. | Mozo, Caja, Admin |
| **Tickets de cocina** | Pantalla "Tickets" para la PC que tiene la impresora: avisa con sonido cada ticket nuevo y permite imprimirlo (uno o todos los pendientes). En Chrome/Edge se puede activar la **impresión automática**. Si un admin modifica una comanda ya enviada, el ticket se reimprime marcado como MODIFICADA. | Caja, Admin |
| **Cobro y comprobante** | Cobrar una comanda o **la mesa completa**, eligiendo la forma de pago (efectivo con cálculo de vuelto, Yape, Plin, tarjeta, transferencia, otro). Se genera el **comprobante en PDF**. Un cobro se puede anular. Cobrar libera la mesa. | Caja, Admin |
| **Reporte del día** | Comandas, mesas atendidas, empleados en turno, total vendido y cobrado, **cobros por forma de pago**, ventas por empleado y por mesa, platos más vendidos, **guarniciones servidas** y tiempo promedio de cocina a entrega. Se puede elegir otra fecha e imprimir. | Admin, Caja |
| **Turnos** | El turno se abre automáticamente al ingresar. El empleado lo cierra con "Finalizar turno y salir". | Todos |

### Quién puede cambiar cada etapa

| De → a | Quién |
|---|---|
| Generado → En cocina | Mozo, Caja |
| En cocina → Entregado | Mozo, Caja |
| Generado → Cancelado | Mozo, Caja |
| En cocina → Cancelado | Caja |
| Cualquier cambio | Admin |

Solo se pueden editar las comandas que todavía no se enviaron a cocina (el admin puede editarlas
hasta que se entreguen; su ticket vuelve a quedar pendiente de impresión).

### Impresión

- **Ticket de cocina:** sin precios y con letra grande; muestra mesa, mozo, platos, cambios de
  guarnición resaltados ("CAMBIO: Yuca frita (en vez de Arroz)", "SIN ARROZ") y notas.
- **Comprobante:** datos del local (de `config.json`), detalle, total, forma de pago, recibido y vuelto.
  Es un **comprobante interno**: no reemplaza a la boleta o factura electrónica.
- Ambos son PDF de 80 mm de ancho: sirven en una impresora térmica de tickets o en una impresora común.
- Con **Chrome o Edge** en la computadora de la impresora, se abre directamente el diálogo de
  impresión (o se imprime solo, con la opción automática y la impresora predeterminada). En otros
  navegadores el PDF se abre en una pestaña para imprimirlo.

---

## 2. Instalación en la PC servidor (Windows)

1. Instale **Node.js 22 LTS o más reciente** (versión mínima 22.13) desde <https://nodejs.org>
   (opciones por defecto).
2. Copie la carpeta `comandas` a un lugar fijo, por ejemplo `C:\comandas`.
3. Edite `config.json` con los datos del local (aparecen en el comprobante):
   ```json
   {
     "puerto": 3000,
     "nombreRestaurante": "Mi Restaurante",
     "moneda": "S/",
     "diasRespaldo": 30,
     "ruc": "",
     "direccion": "",
     "telefono": "",
     "pieComprobante": "¡Gracias por su preferencia!",
     "avisoComprobante": "Comprobante interno. No reemplaza a la boleta o factura electrónica."
   }
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
| `mozo1`, `mozo2`, `mozo3` | `1234` | Mozo |
| `caja1` | `1234` | Caja |
| `cocina1` | `1234` | Cocina |

**Cambie estas contraseñas** (Gestión → Usuarios) y reemplace las mesas y platos de ejemplo
por los suyos antes de usarlo en serio.

**Rutina diaria sugerida:**
1. El admin entra a *Gestión → Carta del día* y pulsa *"Copiar carta del día anterior"*.
2. Marca o desmarca los platos de menú que salen hoy y las guarniciones a elección del día.
3. En la PC de la impresora se abre la pantalla **Tickets** (usuario de caja) y queda abierta
   durante el servicio.

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
│   ├── db.js              esquema SQLite, migraciones, datos iniciales y respaldos
│   └── pdf.js             tickets de cocina y comprobantes en PDF (80 mm)
├── public/                app web para celulares (HTML/CSS/JS sin frameworks)
├── scripts/windows/       arranque automático en Windows
├── scripts/linux/         servicio systemd
└── data/                  base de datos y respaldos (se crea sola)
```

- **Node.js + Express**, base de datos **SQLite** integrada en Node (`node:sqlite`), sin
  motor de base de datos aparte.
- Contraseñas guardadas con hash `scrypt`; las sesiones usan una cookie `HttpOnly`.
- PDF generados en el servidor con `pdfkit`.
- Tablas: `usuarios`, `sesiones`, `turnos`, `mesas`, `guarniciones`, `productos` (catálogo de platos),
  `menu_dia` y `guarniciones_dia` (carta de cada día), `comandas`, `comanda_items` (con las guarniciones
  elegidas), `comanda_historial`, `cobros`.
- Al iniciar, el servidor actualiza automáticamente una base de datos de la versión anterior.

### Limitaciones de este MVP (siguientes pasos posibles)

- Usa HTTP sin cifrar: está pensado solo para la red interna del restaurante.
- La impresión pasa por el navegador (PDF). La impresión directa a una impresora térmica de red,
  sin diálogo, queda para cuando se tenga la impresora.
- El comprobante es interno: no emite boletas ni facturas electrónicas.
- El sonido de aviso necesita que el celular tenga la página abierta y la pantalla encendida
  (los navegadores no permiten notificaciones push sin HTTPS).
- Sin control de inventario ni división de una comanda en varios pagos.
