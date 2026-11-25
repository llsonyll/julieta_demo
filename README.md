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

Abra <http://localhost:3000> en la PC, toque **Administrador** e ingrese el PIN `1234`.
La consola muestra también la dirección para los celulares (`http://192.168.x.x:3000`).
Para que arranque solo al encender la PC, vea la sección 2.

Para desarrollo (se reinicia al guardar cambios): `npm run dev`.

---

## 1. Funciones

| Módulo | Qué hace | Quién lo usa |
|---|---|---|
| **Usuarios y roles** | Crear, editar, desactivar y eliminar usuarios. Cada uno ingresa eligiendo su nombre y marcando su **PIN de 4 dígitos**. Roles: `admin`, `mozo`, `caja`, `cocina`. | Admin |
| **Platos** | Catálogo de platos que se crea una sola vez. Cada plato es **Menú del día** (sale los días que se marque) o **Extra** (carta fija). Tiene precio, una **guarnición por defecto** (ej: arroz) y puede llevar **una guarnición a elección**. Se indica si es para mesa, para llevar o ambos. | Admin |
| **Guarniciones** | Lista de guarniciones (arroz, papas, picante de lisas, kapchi…). No cambian el precio del plato. | Admin |
| **Carta del día** | Pantalla diaria del admin: marcar qué platos de menú salen y qué guarniciones a elección se ofrecen ese día. Botón **"Copiar carta del día anterior"**. | Admin |
| Agotado | Marcar un plato como agotado (deja de poder pedirse). | Admin, Caja, Cocina |
| **Mesas** | Cada mesa tiene un mozo asignado, pero **cualquier mozo puede atender cualquier mesa**. Vista de mesas libres y ocupadas con su consumo. | Admin (gestión), todos (vista) |
| **Comandas** | El mozo elige la mesa y los platos. En cada plato puede **cambiar o quitar la guarnición por defecto**, elegir la **guarnición a elección del día**, la cantidad y una nota. La caja puede tomar pedidos para llevar. | Mozo, Caja, Admin |
| **Etapas** | Generado → **En cocina** (se genera el ticket) → **Entregado** (lo marca el mozo), y Cancelado. Cada cambio queda en el historial con hora y usuario. | Mozo, Caja, Admin |
| **Tickets de cocina** | Pantalla "Tickets" para la PC que tiene la impresora: avisa con sonido cada ticket nuevo y permite imprimirlo (uno o todos los pendientes). En Chrome/Edge se puede activar la **impresión automática**. Si un admin modifica una comanda ya enviada, el ticket se reimprime marcado como MODIFICADA. | Caja, Admin |
| **Cobro y comprobante** | Cobrar una comanda o **la mesa completa**, eligiendo la forma de pago (efectivo con cálculo de vuelto, Yape, Plin, tarjeta, transferencia, otro). Se genera el **comprobante en PDF**. El botón **"Detalle para boleta SUNAT"** muestra los platos agrupados (cantidad, descripción, precio e importe) para copiarlos con un toque en SEE-SOL. Un cobro se puede anular. Cobrar libera la mesa. | Caja, Admin |
| **Comprobantes SUNAT** | Al cobrar se elige **nota de venta** (se imprime al instante) o **boleta/factura SUNAT**. En el segundo caso se emite en SOL con los datos del cobro, se descarga el XML y se sube en *Comprobantes SUNAT*: el sistema lo vincula con su cobro y lo imprime (ticketera o PDF) con QR. Ver sección 3.2. | Caja, Admin |
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
- **Comprobante:** logo del local (`server/logo-comprobante.png`, en negro para impresora térmica), datos del local (de `config.json`), detalle, total, forma de pago, recibido y vuelto.
  Es un **comprobante interno**: no reemplaza a la boleta o factura electrónica.
- **Con ticketera térmica** (Gestión → Impresora, ver sección 3.1): el servidor imprime directo en
  la ticketera en ESC/POS, sin diálogos y cortando el papel. Cada comanda sale sola al enviarse a
  cocina; la precuenta y el comprobante salen al pedirlos en caja.
- **Sin ticketera:** se generan PDF de 80 mm. Con **Chrome o Edge** se abre directamente el diálogo de
  impresión (o se imprime solo, con la opción automática y la impresora predeterminada); en otros
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
     "nombreRestaurante": "Picantería Julieta",
     "moneda": "S/",
     "diasRespaldo": 30,
     "tasaIGV": 0,
     "ruc": "",
     "direccion": "",
     "telefono": "",
     "pieComprobante": "¡Gracias por su preferencia!",
     "avisoComprobante": "Comprobante interno. No reemplaza a la boleta o factura electrónica."
   }
   ```
   `tasaIGV` (opcional): porcentaje total de IGV + IPM del local, por ejemplo `18` en el régimen
   general o la tasa reducida vigente si es restaurante MYPE (confírmela con su contador). Si se llena,
   el detalle para boleta SUNAT muestra también el valor unitario sin IGV. Con `0` no se muestra.
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

### 3.1 Ticketera térmica (Bluetooth, USB o red)

El servidor imprime directo en la ticketera, sin abrir diálogos. Funciona con impresoras ESC/POS
(Xprinter, Epson y compatibles) de 80 mm o 58 mm. Se configura en **Gestión → Impresora**.

**Bluetooth (por ejemplo, Xprinter con Bluetooth) en Windows 10:**

1. Encienda la ticketera. En la PC servidor abra **Configuración → Dispositivos → Bluetooth y otros
   dispositivos → Agregar Bluetooth** y elija la impresora. Si pide un PIN, suele ser `0000` o `1234`
   (viene en el manual o en el ticket de autodiagnóstico de la impresora).
2. En la misma pantalla abra **Más opciones de Bluetooth → Puertos COM** y anote el puerto
   **Saliente** de la impresora (por ejemplo `COM5`).
3. En el sistema, entre como administrador a **Gestión → Impresora**, elija
   **"Bluetooth o USB (puerto COM)"** y escriba el puerto (o use **Buscar dispositivos** y tóquelo).
4. Pulse **Guardar** y luego **Imprimir prueba**. El ticket de prueba muestra el logo, los acentos y
   el ancho: los números de la línea de prueba deben ocupar todo el renglón.
   - Si los acentos salen como símbolos raros, cambie "Acentos y ñ" a **Windows-1252**.
   - Si la línea de números se parte en dos, elija el ancho de **42 caracteres**.

**Otras conexiones:**

- **Instalada en Windows:** si la ticketera ya está instalada con el controlador del fabricante
  (USB o Bluetooth), elija "Impresora instalada en Windows" y su nombre tal como aparece en
  *Dispositivos e impresoras*. El sistema le envía los comandos directamente (RAW).
- **Red (IP):** elija "Impresora de red" y escriba la IP de la ticketera (puerto 9100). Reserve esa
  IP en el router para que no cambie.

**Cómo trabaja:**

- Cada comanda se imprime sola al enviarse a cocina (se puede desactivar o pedir 2 o 3 copias).
  Si un admin modifica una comanda que ya estaba en cocina, se reimprime marcada como MODIFICADA.
- La precuenta y el comprobante de pago salen por la ticketera al pedirlos en caja (opción "Imprimir
  también precuentas y comprobantes"). El PDF del comprobante sigue disponible en el detalle de la comanda.
- Todo pasa por una **cola**: si la impresora está apagada, sin papel o el Bluetooth se desconectó,
  los tickets esperan y se reintentan solos, en orden. La caja y la cocina ven un aviso y el ícono de
  impresora de la barra superior se pone en rojo. En la pantalla **Cocina** se ve la cola, con
  "Reintentar ahora" y "Quitar".

**Si no imprime:**

| Síntoma | Qué revisar |
|---|---|
| "No se pudo abrir el puerto" o "Access to the port is denied" | Que la impresora esté encendida y cerca, que el puerto sea el **saliente** y que ningún otro programa (por ejemplo, la utilidad del fabricante) lo tenga abierto. |
| Funciona con `iniciar-manual.bat` pero no con el arranque automático | El arranque automático corre como cuenta del sistema. Abra el Programador de tareas, tarea **ComandasRestaurante** → Propiedades → "Cambiar usuario o grupo" y elija el usuario de Windows que emparejó la impresora (marque "Ejecutar tanto si el usuario inició sesión como si no"). |
| Acentos raros | Cambie "Acentos y ñ" a Windows-1252 (o al revés) e imprima otra prueba. |
| Imprime pero no corta | Desmarque "Cortar el papel" si el modelo no tiene cortador. |

### 3.2 Boletas y facturas electrónicas (SUNAT, portal SOL)

Las boletas y facturas se emiten en el portal **SOL de SUNAT** (SEE-SOL). El sistema facilita los datos
para emitirlas y luego imprime el comprobante a partir del XML que entrega SUNAT.

1. **Cobrar:** en la ventana de cobro elija **"Boleta o factura (SUNAT)"**. Se cobra sin imprimir y se
   muestra el detalle (cantidad, descripción, precio, importe) para copiarlo en SOL con un toque.
2. **Emitir en SOL** la boleta o factura y **descargar su XML** (o el ZIP que lo contiene).
3. **Subir el XML** en la pantalla **Comprobantes SUNAT** (tocando el recuadro o arrastrando el archivo).
   El sistema lee el comprobante y lo **vincula solo** con el cobro pendiente del mismo día y el mismo total.
   Si hay varios cobros con ese total, pregunta a cuál corresponde. Luego **lo imprime**: en la ticketera
   asignada a comprobantes o, sin ticketera, en PDF.
4. En *Comprobantes SUNAT* quedan los **pendientes** (cobros esperando su XML, con sus datos para SOL)
   y los **emitidos** del día, con Imprimir, PDF y el XML original. El detalle de cada comanda muestra
   su boleta o factura.

Lo impreso incluye los datos del XML: emisor (razón social, RUC, dirección), tipo y serie-número,
fecha, cliente (DNI o RUC), detalle, operación gravada, IGV, importe total, monto en letras, el valor
resumen y el **código QR** con el formato de SUNAT. Los XML se guardan en `data/sunat/`.

> Sobre la validez de esta representación impresa como sustituto del PDF que entrega SOL, consulte
> con su contador. Los datos y el QR salen del propio XML emitido por SUNAT.

---

## 4. Primer uso

Al iniciar por primera vez se crea la base de datos con datos de ejemplo:

| Usuario | Rol |
|---|---|
| Administrador | Administrador |
| Mozo Uno, Mozo Dos, Mozo Tres | Mozo |
| Caja | Caja |
| Cocina | Cocina |

Para ingresar se toca el nombre en la pantalla **"¿Quién eres?"** y se marca el **PIN de 4 dígitos**.
Todos empiezan con el PIN `1234`: **cámbielo para cada usuario** (Gestión → Usuarios) y revise las
mesas de ejemplo antes de usarlo en serio. En la PC también se puede marcar el PIN con el teclado.

Tras 5 PIN incorrectos seguidos, ese usuario queda bloqueado 5 minutos (o hasta que el admin le
cambie el PIN). Al actualizar desde una versión con contraseñas, los usuarios existentes reciben
el PIN `1234` y la consola lo avisa.

### Carta de platos tradicionales

La carta inicial está en `carta/platos-tradicionales.json` (platos, precios y guarniciones).
Una instalación nueva la carga sola. Para cargarla o actualizarla en una base de datos que ya
está en uso (no borra nada; busca cada plato por su nombre y lo crea o actualiza):

```bash
npm run cargar-carta
```

Para además ocultar los platos que no están en el archivo (por ejemplo, los platos de ejemplo
de versiones anteriores):

```bash
npm run cargar-carta -- --desactivar-otros
```

Los platos principales llevan **arroz** por defecto (se puede cambiar sin costo) y una
**guarnición a elección**: papas, choclo o kapchi de habas, que están marcadas como
"a elección habitual" y se ofrecen los días en que la Carta del día no marca otras.
Los caldos y los platos con acompañamiento propio (cuy, merienda, panceta, chicharrón) no llevan guarnición.

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
│   ├── pdf.js             tickets de cocina y comprobantes en PDF (80 mm)
│   ├── sunat.js           lectura del XML de boletas y facturas de SUNAT (UBL 2.1) y su registro
│   ├── escpos.js          los mismos documentos en ESC/POS para la ticketera (logo incluido)
│   └── impresora.js       ajustes de la ticketera, cola con reintentos y envío (COM, Windows, red)
├── public/                app web para celulares (HTML/CSS/JS sin frameworks)
├── scripts/windows/       arranque automático en Windows
├── scripts/linux/         servicio systemd
└── data/                  base de datos y respaldos (se crea sola)
```

- **Node.js + Express**, base de datos **SQLite** integrada en Node (`node:sqlite`), sin
  motor de base de datos aparte.
- PIN guardados con hash `scrypt` y bloqueo tras 5 intentos fallidos; las sesiones usan una cookie `HttpOnly`.
- PDF generados en el servidor con `pdfkit`.
- Tablas: `usuarios`, `sesiones`, `turnos`, `mesas`, `guarniciones`, `productos` (catálogo de platos),
  `menu_dia` y `guarniciones_dia` (carta de cada día), `comandas`, `comanda_items` (con las guarniciones
  elegidas), `comanda_historial`, `cobros`.
- Al iniciar, el servidor actualiza automáticamente una base de datos de la versión anterior.

### Limitaciones de este MVP (siguientes pasos posibles)

- Usa HTTP sin cifrar: está pensado solo para la red interna del restaurante.
- Sin ticketera configurada, la impresión pasa por el navegador (PDF).
- El comprobante es interno: no emite boletas ni facturas electrónicas.
- El sonido de aviso necesita que el celular tenga la página abierta y la pantalla encendida
  (los navegadores no permiten notificaciones push sin HTTPS).
- Sin control de inventario ni división de una comanda en varios pagos.
