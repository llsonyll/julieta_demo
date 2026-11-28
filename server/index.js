// Servidor de comandas - red local
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const { db, tx, hoy, ahora, hashPassword, verificarPassword, esPin, sembrar, respaldar } = require('./db');
const { generarPDF, ticketCocina, comprobante, comprobanteSunat } = require('./pdf');
const sunat = require('./sunat');
const { leerCarta, cargarCarta } = require('./carta-inicial');
const { documentoESCPOS, documentoPrueba } = require('./escpos');
const impresora = require('./impresora');

const CONFIG = Object.assign(
  {
    puerto: 3000,
    nombreRestaurante: 'Mi Restaurante',
    moneda: 'S/',
    diasRespaldo: 30,
    ruc: '',
    direccion: '',
    telefono: '',
    tasaIGV: 0, // % total (IGV + IPM) para mostrar el valor sin IGV en el detalle para SUNAT; 0 = no se muestra
    pieComprobante: '¡Gracias por su preferencia!',
    avisoComprobante: 'Comprobante interno. No reemplaza a la boleta o factura electrónica.',
  },
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
);
const PUERTO = Number(process.env.PORT || CONFIG.puerto);

const ROLES = ['admin', 'mozo', 'caja', 'cocina'];
const ESTADOS = ['generado', 'enviado_cocina', 'entregado', 'cancelado'];
const EN_COCINA = ['enviado_cocina', 'en_proceso', 'esperando_entrega']; // los dos últimos: datos antiguos
const METODOS_PAGO = ['Efectivo', 'Yape', 'Plin', 'Tarjeta', 'Transferencia', 'Otro'];
// Transiciones permitidas: estado actual -> { nuevo estado: roles } (el admin puede forzar cualquiera)
const TRANSICIONES = {
  generado: { enviado_cocina: ['mozo', 'caja'], cancelado: ['mozo', 'caja'] },
  enviado_cocina: { entregado: ['mozo', 'caja'], cancelado: ['caja'] },
  en_proceso: { entregado: ['mozo', 'caja'], cancelado: ['caja'] },
  esperando_entrega: { entregado: ['mozo', 'caja'], cancelado: ['caja'] },
  entregado: {},
  cancelado: {},
};

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------- utilidades ----------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, msg) => {
  throw new HttpError(status, msg);
};
const ruta = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res);
    if (r && typeof r.then === 'function') r.then((v) => v !== undefined && res.json(v)).catch(next);
    else if (r !== undefined) res.json(r);
  } catch (e) {
    next(e);
  }
};
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const redondear = (n) => Math.round(n * 100) / 100;
const listaIds = (v) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(Number).filter((n) => Number.isInteger(n) && n > 0))];

function leerCookie(req, nombre) {
  const c = req.headers.cookie || '';
  for (const parte of c.split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nombre) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ---------------- tiempo real (Server-Sent Events) ----------------
const clientes = new Set();
function emitir(evento, datos = {}) {
  const msg = `event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`;
  for (const c of clientes) c.res.write(msg);
}
setInterval(() => {
  for (const c of clientes) c.res.write(': ping\n\n');
}, 25000).unref();

// ---------------- autenticación ----------------
function auth(req, res, next) {
  const token = leerCookie(req, 'token');
  if (!token) return next(new HttpError(401, 'No autenticado'));
  const u = db
    .prepare(
      `SELECT u.id, u.nombre, u.usuario, u.rol FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id WHERE s.token = ? AND u.activo = 1`
    )
    .get(token);
  if (!u) return next(new HttpError(401, 'Sesión expirada'));
  u.roles = db.prepare('SELECT rol FROM usuario_roles WHERE usuario_id = ?').all(u.id).map((r) => r.rol);
  if (!u.roles.length) u.roles = [u.rol];
  req.user = u;
  req.token = token;
  next();
}
const rol = (...roles) => (req, res, next) =>
  req.user.roles.some((r) => roles.includes(r)) ? next() : next(new HttpError(403, 'No tiene permiso para esta acción'));

function abrirTurno(usuarioId) {
  const abierto = db.prepare('SELECT * FROM turnos WHERE usuario_id = ? AND fin IS NULL').get(usuarioId);
  if (abierto && abierto.fecha === hoy()) return abierto;
  if (abierto) db.prepare('UPDATE turnos SET fin = ? WHERE id = ?').run(`${abierto.fecha} 23:59:59`, abierto.id);
  const id = db
    .prepare('INSERT INTO turnos (usuario_id, fecha, inicio) VALUES (?,?,?)')
    .run(usuarioId, hoy(), ahora()).lastInsertRowid;
  return db.prepare('SELECT * FROM turnos WHERE id = ?').get(id);
}
function turnoActual(usuarioId) {
  return db.prepare('SELECT * FROM turnos WHERE usuario_id = ? AND fin IS NULL AND fecha = ?').get(usuarioId, hoy()) || null;
}

// Lista para la pantalla de ingreso ("¿Quién eres?"): solo nombre y rol.
app.get(
  '/api/login/usuarios',
  ruta(() => db.prepare('SELECT id, nombre, rol FROM usuarios WHERE activo = 1 ORDER BY rol, nombre').all())
);

// Un PIN de 4 dígitos se adivina probando: tras MAX_FALLOS seguidos se bloquea ese usuario un rato.
// ponytail: en memoria, se reinicia con el servidor; basta para una red local.
const MAX_FALLOS = 5;
const BLOQUEO_MS = 5 * 60 * 1000;
const fallos = new Map(); // usuarioId -> { n, hasta }

app.post(
  '/api/login',
  ruta((req, res) => {
    const id = Number(req.body.id);
    const f = fallos.get(id);
    if (f?.hasta > Date.now()) fail(429, `Demasiados intentos. Espere ${Math.ceil((f.hasta - Date.now()) / 60000)} min o pida ayuda al administrador.`);
    const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND activo = 1').get(id);
    if (!u) fail(401, 'Usuario no encontrado');
    if (!esPin(req.body.pin) || !verificarPassword(req.body.pin, u.pin_hash)) {
      const n = (f?.hasta ? 0 : f?.n ?? 0) + 1;
      fallos.set(id, n >= MAX_FALLOS ? { n, hasta: Date.now() + BLOQUEO_MS } : { n });
      fail(401, n >= MAX_FALLOS ? 'PIN incorrecto. Usuario bloqueado por 5 minutos.' : 'PIN incorrecto');
    }
    fallos.delete(id);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sesiones (token, usuario_id, creado_en) VALUES (?,?,?)').run(token, u.id, ahora());
    const turno = abrirTurno(u.id);
    emitir('turnos');
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
    const roles = db.prepare('SELECT rol FROM usuario_roles WHERE usuario_id = ?').all(u.id).map((r) => r.rol);
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, roles: roles.length ? roles : [u.rol], turno };
  })
);

// ---------------- dirección para entrar desde los celulares ----------------
// Adaptadores que no son la red del local (Windows crea varios virtuales)
const ADAPTADOR_VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vbox|vmware|docker|bluetooth|tailscale|zerotier|hamachi|vpn|loopback/i;
const ADAPTADOR_LOCAL = /wi-?fi|wlan|wireless|ethernet|^eth|^en\d|^wl/i;
const esPrivada = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** Direcciones IPv4 de esta PC en la red, primero las del WiFi o cable de red del local */
function direccionesRed() {
  const lista = [];
  for (const [interfaz, ifs] of Object.entries(os.networkInterfaces()))
    for (const i of ifs || [])
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.'))
        lista.push({ ip: i.address, interfaz, url: `http://${i.address}:${PUERTO}`, virtual: ADAPTADOR_VIRTUAL.test(interfaz) });
  const puntaje = (d) => (d.virtual ? 0 : 4) + (esPrivada(d.ip) ? 2 : 0) + (ADAPTADOR_LOCAL.test(d.interfaz) ? 1 : 0);
  lista.sort((a, b) => puntaje(b) - puntaje(a));
  const reales = lista.filter((d) => !d.virtual);
  return (reales.length ? reales : lista).map(({ ip, interfaz, url }) => ({ ip, interfaz, url }));
}

// QR con la dirección (solo de las direcciones de esta PC)
app.get(
  '/api/red/qr.svg',
  ruta(async (req, res) => {
    const d = direccionesRed().find((x) => x.url === req.query.u) || direccionesRed()[0];
    if (!d) fail(404, 'Esta PC no está conectada a ninguna red');
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await QRCode.toString(d.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  })
);

app.get('/api/config', (req, res) =>
  res.json({
    direcciones: direccionesRed(),
    nombreRestaurante: CONFIG.nombreRestaurante,
    direccion: CONFIG.direccion,
    moneda: CONFIG.moneda,
    tasaIGV: Number(CONFIG.tasaIGV) || 0,
    estados: ESTADOS,
    metodosPago: METODOS_PAGO,
    ahora: ahora(),
    hoy: hoy(),
  })
);

app.use('/api', auth);

app.get('/api/me', ruta((req) => ({ ...req.user, turno: turnoActual(req.user.id) })));

app.post(
  '/api/logout',
  ruta((req, res) => {
    if (req.body?.finalizarTurno) {
      db.prepare('UPDATE turnos SET fin = ? WHERE usuario_id = ? AND fin IS NULL').run(ahora(), req.user.id);
      emitir('turnos');
    }
    db.prepare('DELETE FROM sesiones WHERE token = ?').run(req.token);
    res.setHeader('Set-Cookie', 'token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return { ok: true };
  })
);

app.post(
  '/api/turnos/iniciar',
  ruta((req) => {
    const t = abrirTurno(req.user.id);
    emitir('turnos');
    return t;
  })
);

app.get('/api/eventos', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const cliente = { res, user: req.user };
  clientes.add(cliente);
  req.on('close', () => clientes.delete(cliente));
});

// ---------------- usuarios (admin) ----------------
const COLS_USUARIO = 'id, nombre, usuario, rol, activo, creado_en';

app.get(
  '/api/usuarios',
  rol('admin'),
  ruta(() =>
    db
      .prepare(
        `SELECT ${COLS_USUARIO},
          (SELECT GROUP_CONCAT(ur.rol) FROM usuario_roles ur WHERE ur.usuario_id = usuarios.id) AS roles_csv,
          (SELECT COUNT(*) FROM mesas m WHERE m.mozo_id = usuarios.id) AS mesas_asignadas,
          EXISTS (SELECT 1 FROM turnos t WHERE t.usuario_id = usuarios.id AND t.fin IS NULL AND t.fecha = ?) AS en_turno
         FROM usuarios ORDER BY activo DESC, rol, nombre`
      )
      .all(hoy())
      .map(({ roles_csv, ...u }) => ({ ...u, roles: roles_csv ? roles_csv.split(',') : [u.rol] }))
  )
);

function validarUsuario(b, nuevo) {
  const nombre = texto(b.nombre, 80);
  const usuario = texto(b.usuario, 40).toLowerCase();
  if (!nombre) fail(400, 'El nombre es obligatorio');
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) fail(400, 'Usuario: 3 a 40 caracteres (letras, números, . _ -)');
  if (!ROLES.includes(b.rol)) fail(400, 'Rol inválido');
  if ((nuevo || b.pin) && !esPin(b.pin)) fail(400, 'El PIN debe tener exactamente 4 dígitos');
  const rolesExtra = Array.isArray(b.roles_extra) ? b.roles_extra.filter((r) => ROLES.includes(r) && r !== b.rol) : [];
  return { nombre, usuario, rol: b.rol, activo: b.activo === undefined ? 1 : bool(b.activo), rolesExtra };
}
const existeUsuario = (usuario, exceptoId = 0) =>
  db.prepare('SELECT 1 FROM usuarios WHERE usuario = ? AND id <> ?').get(usuario, exceptoId);

function sincRoles(usuarioId, rolPrincipal, rolesExtra) {
  const insRol = db.prepare('INSERT OR IGNORE INTO usuario_roles (usuario_id, rol) VALUES (?,?)');
  db.prepare('DELETE FROM usuario_roles WHERE usuario_id = ?').run(usuarioId);
  insRol.run(usuarioId, rolPrincipal);
  for (const r of rolesExtra) insRol.run(usuarioId, r);
}

app.post(
  '/api/usuarios',
  rol('admin'),
  ruta((req) => {
    const u = validarUsuario(req.body, true);
    if (existeUsuario(u.usuario)) fail(409, 'Ese nombre de usuario ya existe');
    const id = db
      .prepare("INSERT INTO usuarios (nombre, usuario, pin_hash, rol, activo, creado_en, password_hash) VALUES (?,?,?,?,?,?,'')")
      .run(u.nombre, u.usuario, hashPassword(req.body.pin), u.rol, u.activo, ahora()).lastInsertRowid;
    sincRoles(id, u.rol, u.rolesExtra);
    return db.prepare(`SELECT ${COLS_USUARIO} FROM usuarios WHERE id = ?`).get(id);
  })
);

app.put(
  '/api/usuarios/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM usuarios WHERE id = ?').get(id)) fail(404, 'Usuario no encontrado');
    const u = validarUsuario(req.body, false);
    if (existeUsuario(u.usuario, id)) fail(409, 'Ese nombre de usuario ya existe');
    if (id === req.user.id && (u.rol !== 'admin' || !u.activo)) fail(400, 'No puede quitarse el rol de admin ni desactivarse a sí mismo');
    db.prepare('UPDATE usuarios SET nombre=?, usuario=?, rol=?, activo=? WHERE id=?').run(u.nombre, u.usuario, u.rol, u.activo, id);
    sincRoles(id, u.rol, u.rolesExtra);
    if (req.body.pin) {
      db.prepare('UPDATE usuarios SET pin_hash=? WHERE id=?').run(hashPassword(req.body.pin), id);
      fallos.delete(id); // el admin cambia el PIN: se desbloquea
    }
    if (!u.activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
    if (![u.rol, ...u.rolesExtra].includes('mozo')) db.prepare('UPDATE mesas SET mozo_id = NULL WHERE mozo_id = ?').run(id);
    emitir('mesas');
    return db.prepare(`SELECT ${COLS_USUARIO} FROM usuarios WHERE id = ?`).get(id);
  })
);

app.delete(
  '/api/usuarios/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (id === req.user.id) fail(400, 'No puede eliminarse a sí mismo');
    const tieneHistoria = db.prepare('SELECT 1 FROM comandas WHERE mozo_id = ? LIMIT 1').get(id);
    if (tieneHistoria) {
      db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
      return { ok: true, desactivado: true };
    }
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
    return { ok: true };
  })
);

// ---------------- mesas ----------------
function listarMesas() {
  const mesas = db
    .prepare(
      `SELECT m.*,
        (SELECT COUNT(*) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado <> 'cancelado' AND c.pagada = 0) AS comandas_abiertas,
        (SELECT COALESCE(SUM(c.total),0) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado <> 'cancelado' AND c.pagada = 0) AS por_cobrar,
        (SELECT COUNT(*) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado NOT IN ('cancelado','entregado') AND c.pagada = 0) AS por_entregar,
        (SELECT MIN(c.creado_en) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado <> 'cancelado' AND c.pagada = 0) AS ocupada_desde
       FROM mesas m
       ORDER BY CAST(m.numero AS INTEGER), m.numero`
    )
    .all(hoy(), hoy(), hoy(), hoy())
    .map((m) => ({ ...m, ocupada: m.comandas_abiertas > 0 }));
  const porId = new Map(mesas.map((m) => [m.id, m]));
  for (const m of mesas) m.principal_id = m.unida_a && porId.has(m.unida_a) ? m.unida_a : m.id;
  for (const m of mesas)
    m.etiqueta = mesas
      .filter((x) => x.principal_id === m.principal_id)
      .map((x) => x.numero)
      .join('-');
  return mesas;
}

// "10-11" si la mesa está unida, si no su número
function etiquetaGrupo(principalId) {
  return db
    .prepare('SELECT numero FROM mesas WHERE id = ? OR unida_a = ? ORDER BY CAST(numero AS INTEGER), numero')
    .all(principalId, principalId)
    .map((r) => r.numero)
    .join('-');
}
// Las comandas abiertas de la mesa principal muestran la etiqueta del grupo
function refrescarEtiquetas(principalId) {
  db.prepare("UPDATE comandas SET mesa_etiqueta = ? WHERE mesa_id = ? AND pagada = 0 AND estado <> 'cancelado'").run(
    etiquetaGrupo(principalId),
    principalId
  );
}
function separarGrupo(principalId) {
  db.prepare('UPDATE mesas SET unida_a = NULL WHERE unida_a = ?').run(principalId);
  refrescarEtiquetas(principalId);
}

// Todos ven todas las mesas: cualquier mozo puede atender la mesa de otro.
app.get(
  '/api/mesas',
  ruta((req) => {
    const todas = listarMesas();
    return req.user.roles.includes('admin') ? todas : todas.filter((m) => m.activa);
  })
);

function validarMesa(b) {
  const numero = texto(b.numero, 20);
  if (!numero) fail(400, 'El número/nombre de mesa es obligatorio');
  const capacidad = Math.max(1, Math.min(50, parseInt(b.capacidad, 10) || 4));
  const piso = texto(b.piso, 30) || 'Nivel 1';
  const zona = texto(b.zona, 40) || 'Salón';
  const forma = ['cuadrada', 'redonda', 'rectangular'].includes(b.forma) ? b.forma : 'rectangular';
  return { numero, capacidad, piso, zona, forma, activa: b.activa === undefined ? 1 : bool(b.activa) };
}

app.post(
  '/api/mesas',
  rol('admin'),
  ruta((req) => {
    const m = validarMesa(req.body);
    if (db.prepare('SELECT 1 FROM mesas WHERE numero = ?').get(m.numero)) fail(409, 'Ya existe una mesa con ese número');
    const id = db
      .prepare('INSERT INTO mesas (numero, capacidad, piso, zona, forma, activa) VALUES (?,?,?,?,?,?)')
      .run(m.numero, m.capacidad, m.piso, m.zona, m.forma, m.activa).lastInsertRowid;
    emitir('mesas');
    return db.prepare('SELECT * FROM mesas WHERE id = ?').get(id);
  })
);

app.put(
  '/api/mesas/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM mesas WHERE id = ?').get(id)) fail(404, 'Mesa no encontrada');
    const m = validarMesa(req.body);
    if (db.prepare('SELECT 1 FROM mesas WHERE numero = ? AND id <> ?').get(m.numero, id)) fail(409, 'Ya existe una mesa con ese número');
    db.prepare('UPDATE mesas SET numero=?, capacidad=?, piso=?, zona=?, forma=?, activa=? WHERE id=?').run(
      m.numero, m.capacidad, m.piso, m.zona, m.forma, m.activa, id
    );
    emitir('mesas');
    return db.prepare('SELECT * FROM mesas WHERE id = ?').get(id);
  })
);

// Unir mesas (temporal): no cambia sus números, se muestran como "10-11" y comparten cuenta
app.post(
  '/api/mesas/unir',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const ids = listaIds(req.body.ids);
    const todas = listarMesas().filter((m) => m.activa);
    const elegidas = todas.filter((m) => ids.includes(m.id));
    if (elegidas.length !== ids.length) fail(400, 'Mesa no encontrada');
    if (new Set(elegidas.map((m) => m.piso)).size > 1) fail(400, 'Solo se pueden unir mesas del mismo nivel');
    // si alguna ya estaba unida, entra todo su grupo
    const grupos = new Set(elegidas.map((m) => m.principal_id));
    const miembros = todas.filter((m) => grupos.has(m.principal_id));
    if (miembros.length < 2) fail(400, 'Elija al menos dos mesas');
    const principal = miembros[0]; // listarMesas ya viene ordenada por número
    const otras = miembros.slice(1).map((m) => m.id);
    tx(() => {
      for (const m of miembros) db.prepare('UPDATE mesas SET unida_a = ? WHERE id = ?').run(m.id === principal.id ? null : principal.id, m.id);
      // las comandas abiertas de las otras mesas pasan a la principal
      db.prepare(
        `UPDATE comandas SET mesa_id = ? WHERE pagada = 0 AND estado <> 'cancelado' AND mesa_id IN (${otras.map(() => '?').join(',')})`
      ).run(principal.id, ...otras);
      refrescarEtiquetas(principal.id);
    });
    emitir('mesas');
    emitir('comandas', { accion: 'mesas' });
    return { ok: true, etiqueta: etiquetaGrupo(principal.id) };
  })
);

app.post(
  '/api/mesas/:id/separar',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const m = db.prepare('SELECT id, unida_a FROM mesas WHERE id = ?').get(Number(req.params.id));
    if (!m) fail(404, 'Mesa no encontrada');
    separarGrupo(m.unida_a || m.id);
    emitir('mesas');
    emitir('comandas', { accion: 'mesas' });
    return { ok: true };
  })
);

// Plano: elementos fijos (escaleras, caja...) y guardado de posiciones
app.get(
  '/api/plano',
  ruta(() => ({ elementos: db.prepare('SELECT * FROM plano_elementos ORDER BY id').all() }))
);

app.put(
  '/api/plano',
  rol('admin'),
  ruta((req) => {
    const num = (v, min, max) => {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(400, 'Posición inválida');
      return Math.max(min, Math.min(max, Math.round(n * 10) / 10));
    };
    const pos = (o) => [num(o.x, 0, 100), num(o.y, 0, 300), num(o.ancho, 1, 100), num(o.alto, 1, 300), Number(o.id)];
    tx(() => {
      const um = db.prepare('UPDATE mesas SET x=?, y=?, ancho=?, alto=? WHERE id=?');
      for (const m of req.body.mesas || []) um.run(...pos(m));
      const ue = db.prepare('UPDATE plano_elementos SET x=?, y=?, ancho=?, alto=? WHERE id=?');
      for (const e of req.body.elementos || []) ue.run(...pos(e));
    });
    emitir('mesas');
    return { ok: true };
  })
);

app.delete(
  '/api/mesas/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM comandas WHERE mesa_id = ? LIMIT 1').get(id)) {
      db.prepare('UPDATE mesas SET activa = 0 WHERE id = ?').run(id);
      emitir('mesas');
      return { ok: true, desactivada: true };
    }
    db.prepare('DELETE FROM mesas WHERE id = ?').run(id);
    db.prepare('UPDATE mesas SET unida_a = NULL WHERE unida_a = ?').run(id);
    emitir('mesas');
    return { ok: true };
  })
);

// ---------------- guarniciones ----------------
app.get(
  '/api/guarniciones',
  ruta(() => db.prepare('SELECT * FROM guarniciones ORDER BY activo DESC, nombre').all())
);

function validarGuarnicion(b) {
  const nombre = texto(b.nombre, 60);
  if (!nombre) fail(400, 'Escriba el nombre de la guarnición');
  return { nombre, activo: b.activo === undefined ? 1 : bool(b.activo), eleccion_habitual: bool(b.eleccion_habitual) };
}

app.post(
  '/api/guarniciones',
  rol('admin'),
  ruta((req) => {
    const g = validarGuarnicion(req.body);
    if (db.prepare('SELECT 1 FROM guarniciones WHERE nombre = ? COLLATE NOCASE').get(g.nombre)) fail(409, 'Esa guarnición ya existe');
    const id = db
      .prepare('INSERT INTO guarniciones (nombre, activo, eleccion_habitual) VALUES (?,?,?)')
      .run(g.nombre, g.activo, g.eleccion_habitual).lastInsertRowid;
    emitir('productos');
    return db.prepare('SELECT * FROM guarniciones WHERE id = ?').get(id);
  })
);

app.put(
  '/api/guarniciones/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    const g = validarGuarnicion(req.body);
    const r = db
      .prepare('UPDATE guarniciones SET nombre = ?, activo = ?, eleccion_habitual = ? WHERE id = ?')
      .run(g.nombre, g.activo, g.eleccion_habitual, id);
    if (!r.changes) fail(404, 'Guarnición no encontrada');
    emitir('productos');
    return db.prepare('SELECT * FROM guarniciones WHERE id = ?').get(id);
  })
);

app.delete(
  '/api/guarniciones/:id',
  rol('admin'),
  ruta((req) => {
    db.prepare('DELETE FROM guarniciones WHERE id = ?').run(Number(req.params.id));
    emitir('productos');
    return { ok: true };
  })
);

// ---------------- platos (catálogo) ----------------
const ROLES_MENU = ['sopa', 'refresco', 'fijo', 'variable'];
// sopa y refresco: uno por día, van incluidos en el menú (no se piden solos ni llevan guarnición)
const UNICOS_DIA = ['sopa', 'refresco'];
const precioMenu = () => Number(db.prepare("SELECT valor FROM ajustes WHERE clave = 'precio_menu'").get()?.valor) || 0;
// Sopa / refresco del día. Sin sopa elegida no hay menú ese día; el refresco es opcional
const unicoDelDia = (fecha, rol) =>
  db.prepare(`SELECT p.* FROM menu_dia m JOIN productos p ON p.id = m.producto_id
    WHERE m.fecha = ? AND p.tipo = 'menu' AND p.menu_rol = ? AND p.activo = 1`).get(fecha, rol) || null;
// El menú lleva una sola sopa y un solo refresco: elegir otro reemplaza al anterior
function incluirEnMenu(fecha, id) {
  const rol = db.prepare("SELECT menu_rol FROM productos WHERE id = ? AND tipo = 'menu'").get(id)?.menu_rol;
  if (UNICOS_DIA.includes(rol))
    db.prepare("DELETE FROM menu_dia WHERE fecha = ? AND producto_id IN (SELECT id FROM productos WHERE tipo = 'menu' AND menu_rol = ?)").run(fecha, rol);
  db.prepare('INSERT OR IGNORE INTO menu_dia (fecha, producto_id) VALUES (?,?)').run(fecha, id);
}
const SQL_PRODUCTO = `SELECT p.*, g.nombre AS guarnicion_base FROM productos p
  LEFT JOIN guarniciones g ON g.id = p.guarnicion_base_id`;

app.get(
  '/api/productos',
  ruta((req) => {
    const where = req.user.roles.includes('admin') ? '1=1' : 'p.activo = 1';
    return db.prepare(`${SQL_PRODUCTO} WHERE ${where} ORDER BY p.tipo DESC, p.categoria, p.nombre`).all();
  })
);

function validarProducto(b) {
  const nombre = texto(b.nombre, 120);
  if (!nombre) fail(400, 'El nombre es obligatorio');
  const tipo = ['menu', 'extra', 'bebidas'].includes(b.tipo) ? b.tipo : fail(400, 'Indique si es menú, extra o bebida');
  const menu_rol = tipo === 'extra' || tipo === 'bebidas' ? 'variable' : ROLES_MENU.includes(b.menu_rol) ? b.menu_rol : fail(400, 'Indique si es sopa, refresco, segundo fijo o variable');
  // los platos del menú no tienen precio propio: se cobra el precio fijo del menú
  const precio = tipo === 'menu' ? 0 : Number(b.precio);
  if (((tipo === 'extra' || tipo === 'bebidas') && b.precio === '') || !Number.isFinite(precio) || precio < 0) fail(400, 'Precio inválido');
  let guarnicion_base_id = b.guarnicion_base_id ? Number(b.guarnicion_base_id) : null;
  if (guarnicion_base_id && !db.prepare('SELECT 1 FROM guarniciones WHERE id = ?').get(guarnicion_base_id))
    fail(400, 'La guarnición elegida no existe');
  const sinGuarnicion = tipo === 'menu' && UNICOS_DIA.includes(menu_rol);
  if (sinGuarnicion) guarnicion_base_id = null; // sopa y refresco no llevan guarnición
  const p = {
    nombre,
    descripcion: texto(b.descripcion, 300),
    categoria: texto(b.categoria, 40) || (tipo === 'menu' ? 'Menú' : 'Otros'),
    precio: redondear(precio),
    tipo,
    menu_rol,
    guarnicion_base_id,
    con_eleccion: sinGuarnicion ? 0 : bool(b.con_eleccion),
    para_local: b.para_local === undefined ? 1 : bool(b.para_local),
    para_llevar: b.para_llevar === undefined ? 1 : bool(b.para_llevar),
    disponible: b.disponible === undefined ? 1 : bool(b.disponible),
    activo: b.activo === undefined ? 1 : bool(b.activo),
  };
  if (!p.para_local && !p.para_llevar) fail(400, 'Debe estar disponible para mesa y/o para llevar');
  return p;
}
const COLS_P = 'nombre, descripcion, categoria, precio, tipo, menu_rol, guarnicion_base_id, con_eleccion, para_local, para_llevar, disponible, activo';
const valoresP = (p) => [p.nombre, p.descripcion, p.categoria, p.precio, p.tipo, p.menu_rol, p.guarnicion_base_id, p.con_eleccion, p.para_local, p.para_llevar, p.disponible, p.activo];

app.post(
  '/api/productos',
  rol('admin'),
  ruta((req) => {
    const p = validarProducto(req.body);
    const id = tx(() => {
      const nuevo = db.prepare(`INSERT INTO productos (${COLS_P}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(...valoresP(p)).lastInsertRowid;
      // una sopa, refresco o segundo variable creado se agrega al menú de la fecha indicada (por defecto, hoy)
      if (p.tipo === 'menu' && p.menu_rol !== 'fijo' && req.body.agregar_a_fecha !== false)
        incluirEnMenu(esFecha(req.body.agregar_a_fecha) ? req.body.agregar_a_fecha : hoy(), nuevo);
      return nuevo;
    });
    emitir('productos');
    return db.prepare(`${SQL_PRODUCTO} WHERE p.id = ?`).get(id);
  })
);

app.put(
  '/api/productos/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM productos WHERE id = ?').get(id)) fail(404, 'Plato no encontrado');
    const p = validarProducto(req.body);
    db.prepare(`UPDATE productos SET ${COLS_P.split(', ').map((c) => `${c}=?`).join(', ')} WHERE id = ?`).run(...valoresP(p), id);
    emitir('productos');
    return db.prepare(`${SQL_PRODUCTO} WHERE p.id = ?`).get(id);
  })
);

// Marcar agotado / disponible
app.post(
  '/api/productos/:id/disponible',
  rol('admin', 'cocina', 'caja'),
  ruta((req) => {
    const id = Number(req.params.id);
    const r = db.prepare('UPDATE productos SET disponible = ? WHERE id = ?').run(bool(req.body.disponible), id);
    if (!r.changes) fail(404, 'Plato no encontrado');
    emitir('productos');
    return db.prepare(`${SQL_PRODUCTO} WHERE p.id = ?`).get(id);
  })
);

app.delete(
  '/api/productos/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM comanda_items WHERE producto_id = ? LIMIT 1').get(id)) {
      db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(id);
      emitir('productos');
      return { ok: true, desactivado: true };
    }
    db.prepare('DELETE FROM productos WHERE id = ?').run(id);
    emitir('productos');
    return { ok: true };
  })
);

// ---------------- carta del día ----------------
function cartaDelDia(fecha, completo) {
  const enMenu = new Set(db.prepare('SELECT producto_id FROM menu_dia WHERE fecha = ?').all(fecha).map((r) => r.producto_id));
  const sopa = unicoDelDia(fecha, 'sopa');
  const refresco = unicoDelDia(fecha, 'refresco');
  const delDia = new Set(db.prepare('SELECT guarnicion_id FROM guarniciones_dia WHERE fecha = ?').all(fecha).map((r) => r.guarnicion_id));
  const productos = db
    .prepare(`${SQL_PRODUCTO} WHERE ${completo ? '1=1' : 'p.activo = 1'} ORDER BY p.categoria, p.nombre`)
    .all()
    .map((p) => ({ ...p, en_carta: p.tipo === 'extra' || p.tipo === 'bebidas' || enMenu.has(p.id) || (p.menu_rol === 'fijo' && sopa) ? 1 : 0 }));
  const guarniciones = db
    .prepare(`SELECT * FROM guarniciones WHERE ${completo ? '1=1' : 'activo = 1'} ORDER BY nombre`)
    .all()
    .map((g) => ({ ...g, del_dia: delDia.has(g.id) ? 1 : 0 }));
  return {
    fecha,
    precio_menu: precioMenu(),
    sopa,
    refresco,
    sopas: productos.filter((p) => p.tipo === 'menu' && p.menu_rol === 'sopa' && (completo || p.en_carta)),
    refrescos: productos.filter((p) => p.tipo === 'menu' && p.menu_rol === 'refresco' && (completo || p.en_carta)),
    // segundos del menú: fijos (todos los días con menú) + variables del día
    menu: productos.filter((p) => p.tipo === 'menu' && !UNICOS_DIA.includes(p.menu_rol) && (completo || (p.en_carta && sopa))),
    extras: productos.filter((p) => p.tipo === 'extra'),
    bebidas: productos.filter((p) => p.tipo === 'bebidas'),
    guarniciones,
  };
}

app.get(
  '/api/carta',
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    return cartaDelDia(fecha, req.user.roles.includes('admin') && req.query.completo === '1');
  })
);

// Incluir o quitar un plato del menú del día
app.post(
  '/api/carta/menu',
  rol('admin'),
  ruta((req) => {
    const fecha = esFecha(req.body.fecha) ? req.body.fecha : hoy();
    const id = Number(req.body.producto_id);
    if (!db.prepare("SELECT 1 FROM productos WHERE id = ? AND tipo = 'menu'").get(id)) fail(404, 'Plato de menú no encontrado');
    if (bool(req.body.incluir)) incluirEnMenu(fecha, id);
    else db.prepare('DELETE FROM menu_dia WHERE fecha = ? AND producto_id = ?').run(fecha, id);
    emitir('productos');
    return { ok: true };
  })
);

app.get(
  '/api/ajustes',
  rol('admin'),
  ruta(() => ({ precio_menu: precioMenu() }))
);

app.put(
  '/api/carta/precio-menu',
  rol('admin'),
  ruta((req) => {
    const precio = Number(req.body.precio);
    if (req.body.precio === '' || !Number.isFinite(precio) || precio < 0) fail(400, 'Precio inválido');
    db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('precio_menu', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(String(redondear(precio)));
    emitir('productos');
    return { ok: true, precio_menu: precioMenu() };
  })
);

// Incluir o quitar una guarnición "a elección" del día
app.post(
  '/api/carta/guarnicion',
  rol('admin'),
  ruta((req) => {
    const fecha = esFecha(req.body.fecha) ? req.body.fecha : hoy();
    const id = Number(req.body.guarnicion_id);
    if (!db.prepare('SELECT 1 FROM guarniciones WHERE id = ?').get(id)) fail(404, 'Guarnición no encontrada');
    if (bool(req.body.incluir)) db.prepare('INSERT OR IGNORE INTO guarniciones_dia (fecha, guarnicion_id) VALUES (?,?)').run(fecha, id);
    else db.prepare('DELETE FROM guarniciones_dia WHERE fecha = ? AND guarnicion_id = ?').run(fecha, id);
    emitir('productos');
    return { ok: true };
  })
);

// Copia la carta (menú + guarniciones a elección) de un día a otro
app.post(
  '/api/carta/copiar',
  rol('admin'),
  ruta((req) => {
    const { desde, hasta } = req.body;
    if (!esFecha(desde) || !esFecha(hasta) || desde === hasta) fail(400, 'Fechas inválidas');
    const r = tx(() => {
      const m = db.prepare('INSERT OR IGNORE INTO menu_dia (fecha, producto_id) SELECT ?, producto_id FROM menu_dia WHERE fecha = ?').run(hasta, desde);
      const g = db
        .prepare('INSERT OR IGNORE INTO guarniciones_dia (fecha, guarnicion_id) SELECT ?, guarnicion_id FROM guarniciones_dia WHERE fecha = ?')
        .run(hasta, desde);
      return m.changes + g.changes;
    });
    if (!r && !db.prepare('SELECT 1 FROM menu_dia WHERE fecha = ? UNION SELECT 1 FROM guarniciones_dia WHERE fecha = ?').get(desde, desde))
      fail(404, 'Ese día no tiene carta registrada');
    emitir('productos');
    return { ok: true, copiados: r };
  })
);

// ---------------- comandas ----------------
const SQL_COMANDA = `
  SELECT c.*, COALESCE(NULLIF(c.mesa_etiqueta, ''), m.numero) AS mesa_numero, m.piso AS mesa_piso, u.nombre AS mozo_nombre,
    co.metodo AS metodo_pago, co.comprobante AS cobro_comprobante,
    (SELECT s.id FROM comprobantes_sunat s WHERE s.cobro_id = c.cobro_id LIMIT 1) AS sunat_id,
    (SELECT s.serie || '-' || s.numero FROM comprobantes_sunat s WHERE s.cobro_id = c.cobro_id LIMIT 1) AS sunat_numero,
    (SELECT h.fecha FROM comanda_historial h WHERE h.comanda_id = c.id AND h.estado = 'enviado_cocina'
       ORDER BY h.id DESC LIMIT 1) AS enviado_en
  FROM comandas c
  LEFT JOIN mesas m ON m.id = c.mesa_id
  LEFT JOIN usuarios u ON u.id = c.mozo_id
  LEFT JOIN cobros co ON co.id = c.cobro_id`;

function adjuntarItems(comandas) {
  if (!comandas.length) return comandas;
  const ids = comandas.map((c) => c.id);
  const items = db
    .prepare(`SELECT * FROM comanda_items WHERE comanda_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
    .all(...ids);
  const porComanda = new Map(ids.map((id) => [id, []]));
  for (const it of items) porComanda.get(it.comanda_id).push(it);
  return comandas.map((c) => ({ ...c, items: porComanda.get(c.id) }));
}

function obtenerComandas(ids) {
  if (!ids.length) return [];
  const filas = db.prepare(`${SQL_COMANDA} WHERE c.id IN (${ids.map(() => '?').join(',')}) ORDER BY c.id`).all(...ids);
  return adjuntarItems(filas);
}

function obtenerComanda(id, conHistorial = false) {
  const [c] = obtenerComandas([id]);
  if (!c) return null;
  if (conHistorial) {
    c.historial = db
      .prepare(
        `SELECT h.estado, h.fecha, u.nombre AS usuario FROM comanda_historial h
         LEFT JOIN usuarios u ON u.id = h.usuario_id WHERE h.comanda_id = ? ORDER BY h.id`
      )
      .all(id);
  }
  return c;
}

function puedeVer(user, c) {
  if (user.rol === 'cocina') return c.estado !== 'generado';
  return true; // admin, caja y cualquier mozo
}

function comandaVisible(req) {
  const c = obtenerComanda(Number(req.params.id), true);
  if (!c || !puedeVer(req.user, c)) fail(404, 'Comanda no encontrada');
  return c;
}

const SQL_EN_COCINA = `c.estado IN (${EN_COCINA.map((e) => `'${e}'`).join(',')})`;

app.get(
  '/api/comandas',
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    const where = ['c.fecha = ?'];
    const params = [fecha];
    const vista = req.user.rol === 'cocina' ? 'cocina' : req.query.vista;
    if (vista === 'cocina') where.push(SQL_EN_COCINA);
    else if (vista === 'activas') where.push("c.estado NOT IN ('entregado','cancelado')");
    else if (vista === 'por_cobrar') where.push("c.estado <> 'cancelado' AND c.pagada = 0");
    if (req.query.mias === '1') {
      where.push('c.mozo_id = ?');
      params.push(req.user.id);
    }
    if (req.query.mesa_id) {
      where.push('c.mesa_id = ?');
      params.push(Number(req.query.mesa_id));
    }
    const filas = db.prepare(`${SQL_COMANDA} WHERE ${where.join(' AND ')} ORDER BY c.id DESC`).all(...params);
    return adjuntarItems(filas);
  })
);

app.get('/api/comandas/:id', ruta((req) => comandaVisible(req)));

// Valida los ítems y toma nombres/precios del catálogo
function prepararItems(itemsBody, tipo) {
  if (!Array.isArray(itemsBody) || !itemsBody.length) fail(400, 'Agregue al menos un plato');
  const getP = db.prepare(`${SQL_PRODUCTO} WHERE p.id = ?`);
  const getG = db.prepare('SELECT * FROM guarniciones WHERE id = ?');
  const sopa = unicoDelDia(hoy(), 'sopa');
  const refresco = unicoDelDia(hoy(), 'refresco');
  return itemsBody.map((it) => {
    const p = getP.get(Number(it.producto_id));
    if (!p || !p.activo) fail(400, 'Uno de los platos ya no existe');
    if (tipo === 'local' && !p.para_local) fail(400, `"${p.nombre}" no está disponible para mesa`);
    if (tipo === 'llevar' && !p.para_llevar) fail(400, `"${p.nombre}" no está disponible para llevar`);
    const cantidad = Math.max(1, Math.min(99, parseInt(it.cantidad, 10) || 1));
    // Menú: se elige el segundo, la sopa y el refresco del día van incluidos y se cobra el precio fijo
    const esMenu = p.tipo === 'menu';
    if (esMenu && UNICOS_DIA.includes(p.menu_rol)) fail(400, `"${p.nombre}" va incluido en el menú: elija un segundo`);
    if (esMenu && !sopa) fail(400, 'Hoy no hay menú (falta elegir la sopa del día)');
    if (esMenu && !precioMenu()) fail(400, 'Falta poner el precio del menú (Gestión → Carta del día)');

    // Guarnición base: la del plato, salvo que se cambie por otra o se quite (null)
    let base = { id: null, nombre: '' };
    const defecto = p.guarnicion_base || '';
    // Todo plato admite una guarnición opcional (sin guarnición por defecto = ninguna)
    if (it.guarnicion_base_id === undefined) {
      if (p.guarnicion_base_id) base = { id: p.guarnicion_base_id, nombre: defecto };
    } else if (it.guarnicion_base_id) {
      const g = getG.get(Number(it.guarnicion_base_id));
      if (!g) fail(400, `Guarnición inválida en "${p.nombre}"`);
      base = { id: g.id, nombre: g.nombre };
    }
    // Guarnición a elección (solo si el plato la lleva)
    let eleccion = { id: null, nombre: '' };
    if (p.con_eleccion && it.guarnicion_eleccion_id) {
      const g = getG.get(Number(it.guarnicion_eleccion_id));
      if (!g) fail(400, `Guarnición inválida en "${p.nombre}"`);
      eleccion = { id: g.id, nombre: g.nombre };
    }
    return {
      producto_id: p.id,
      nombre: esMenu ? `Menú: ${p.nombre}` : p.nombre,
      tipo: p.tipo,
      precio: esMenu ? precioMenu() : p.precio,
      sopa: esMenu ? sopa.nombre : '',
      refresco: esMenu && refresco ? refresco.nombre : '',
      cantidad,
      nota: texto(it.nota, 150),
      disponible: p.disponible,
      guarnicion_base_id: base.id,
      guarnicion_base: base.nombre,
      guarnicion_defecto: p.guarnicion_base_id ? defecto : '',
      guarnicion_eleccion_id: eleccion.id,
      guarnicion_eleccion: eleccion.nombre,
    };
  });
}

function validarCabecera(b) {
  const tipo = b.tipo === 'llevar' ? 'llevar' : 'local';
  let mesa_id = null;
  if (tipo === 'local') {
    const mesa = db.prepare('SELECT id, unida_a FROM mesas WHERE id = ? AND activa = 1').get(Number(b.mesa_id));
    if (!mesa) fail(400, 'Seleccione una mesa válida');
    mesa_id = mesa.unida_a || mesa.id; // en mesas unidas, la comanda va a la principal
  }
  return { tipo, mesa_id, mesa_etiqueta: mesa_id ? etiquetaGrupo(mesa_id) : '', cliente: texto(b.cliente, 80), nota: texto(b.nota, 300) };
}

function guardarItems(comandaId, items) {
  db.prepare('DELETE FROM comanda_items WHERE comanda_id = ?').run(comandaId);
  const ins = db.prepare(
    `INSERT INTO comanda_items (comanda_id, producto_id, nombre, tipo, precio, cantidad, nota,
       guarnicion_base_id, guarnicion_base, guarnicion_defecto, guarnicion_eleccion_id, guarnicion_eleccion, sopa, refresco)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let total = 0;
  for (const it of items) {
    ins.run(comandaId, it.producto_id, it.nombre, it.tipo, it.precio, it.cantidad, it.nota,
      it.guarnicion_base_id, it.guarnicion_base, it.guarnicion_defecto, it.guarnicion_eleccion_id, it.guarnicion_eleccion, it.sopa, it.refresco);
    total += it.precio * it.cantidad;
  }
  db.prepare('UPDATE comandas SET total = ?, actualizado_en = ? WHERE id = ?').run(redondear(total), ahora(), comandaId);
}

function registrarEstado(comandaId, estado, usuarioId) {
  db.prepare('UPDATE comandas SET estado = ?, actualizado_en = ? WHERE id = ?').run(estado, ahora(), comandaId);
  db.prepare('INSERT INTO comanda_historial (comanda_id, estado, usuario_id, fecha) VALUES (?,?,?,?)').run(comandaId, estado, usuarioId, ahora());
  // al enviarse a cocina queda pendiente de imprimir su ticket
  if (estado === 'enviado_cocina') db.prepare('UPDATE comandas SET ticket_impreso = 0 WHERE id = ?').run(comandaId);
}

function notificarComanda(id, accion) {
  const c = db.prepare(`${SQL_COMANDA} WHERE c.id = ?`).get(id);
  emitir(
    'comandas',
    c
      ? { accion, id, numero: c.numero_dia, estado: c.estado, mozo_id: c.mozo_id, mesa: c.mesa_numero, tipo: c.tipo, ticket_impreso: c.ticket_impreso }
      : { accion, id }
  );
  emitir('mesas');
}

app.post(
  '/api/comandas',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const cab = validarCabecera(req.body);
    const items = prepararItems(req.body.items, cab.tipo);
    const agotado = items.find((i) => !i.disponible);
    if (agotado) fail(400, `"${agotado.nombre}" está agotado`);
    const mozoId = req.user.id;
    const id = tx(() => {
      const fecha = hoy();
      const { sig } = db.prepare('SELECT COALESCE(MAX(numero_dia),0)+1 AS sig FROM comandas WHERE fecha = ?').get(fecha);
      const nuevoId = db
        .prepare(
          `INSERT INTO comandas (numero_dia, fecha, tipo, mesa_id, mesa_etiqueta, mozo_id, cliente, nota, estado, creado_en, actualizado_en)
           VALUES (?,?,?,?,?,?,?,?, 'generado', ?, ?)`
        )
        .run(sig, fecha, cab.tipo, cab.mesa_id, cab.mesa_etiqueta, mozoId, cab.cliente, cab.nota, ahora(), ahora()).lastInsertRowid;
      db.prepare('INSERT INTO comanda_historial (comanda_id, estado, usuario_id, fecha) VALUES (?,?,?,?)').run(nuevoId, 'generado', req.user.id, ahora());
      guardarItems(nuevoId, items);
      if (req.body.enviar) registrarEstado(nuevoId, 'enviado_cocina', req.user.id);
      return nuevoId;
    });
    notificarComanda(id, 'creada');
    ticketsAutomaticos(id);
    return obtenerComanda(id, true);
  })
);

app.put(
  '/api/comandas/:id',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const c = comandaVisible(req);
    if (c.pagada) fail(400, 'La comanda ya está cobrada');
    const editable = c.estado === 'generado' || (req.user.roles.includes('admin') && !['entregado', 'cancelado'].includes(c.estado));
    if (!editable) fail(400, 'Solo se pueden editar comandas que aún no se enviaron a cocina');
    const cab = validarCabecera(req.body);
    const items = prepararItems(req.body.items, cab.tipo);
    tx(() => {
      db.prepare('UPDATE comandas SET tipo=?, mesa_id=?, mesa_etiqueta=?, cliente=?, nota=?, actualizado_en=? WHERE id=?').run(
        cab.tipo, cab.mesa_id, cab.mesa_etiqueta, cab.cliente, cab.nota, ahora(), c.id
      );
      guardarItems(c.id, items);
      // si ya estaba en cocina, el ticket se vuelve a imprimir marcado como modificado
      if (EN_COCINA.includes(c.estado)) db.prepare('UPDATE comandas SET ticket_impreso = 0, ticket_modificado = 1 WHERE id = ?').run(c.id);
      if (req.body.enviar && c.estado === 'generado') registrarEstado(c.id, 'enviado_cocina', req.user.id);
    });
    notificarComanda(c.id, 'editada');
    ticketsAutomaticos(c.id);
    return obtenerComanda(c.id, true);
  })
);

app.post(
  '/api/comandas/:id/estado',
  ruta((req) => {
    const c = comandaVisible(req);
    const nuevo = req.body.estado;
    if (!ESTADOS.includes(nuevo)) fail(400, 'Estado inválido');
    if (nuevo === c.estado) return c;
    const permitidos = TRANSICIONES[c.estado]?.[nuevo];
    if (!req.user.roles.includes('admin') && !(permitidos && permitidos.some((r) => req.user.roles.includes(r)))) fail(403, 'No puede hacer ese cambio de estado');
    if (nuevo === 'cancelado' && c.pagada) fail(400, 'Anule primero el cobro');
    tx(() => registrarEstado(c.id, nuevo, req.user.id));
    notificarComanda(c.id, 'estado');
    if (nuevo === 'cancelado') impresora.descartarPendientes('comanda', c.id);
    ticketsAutomaticos(c.id);
    return obtenerComanda(c.id, true);
  })
);

app.delete(
  '/api/comandas/:id',
  rol('admin'),
  ruta((req) => {
    const c = comandaVisible(req);
    db.prepare('DELETE FROM comandas WHERE id = ?').run(c.id);
    impresora.descartarPendientes('comanda', c.id);
    notificarComanda(c.id, 'eliminada');
    return { ok: true };
  })
);

// ---------------- tickets de cocina ----------------
function momento() {
  const a = ahora();
  return `${a.slice(8, 10)}/${a.slice(5, 7)} ${a.slice(11, 16)}`;
}

// PDF con un ticket por página. ?ids=1,2,3
app.get(
  '/api/tickets.pdf',
  ruta(async (req, res) => {
    const ids = listaIds(req.query.ids);
    const comandas = obtenerComandas(ids).filter((c) => c.estado !== 'generado' || req.user.rol !== 'cocina');
    if (!comandas.length) fail(404, 'No hay tickets para imprimir');
    const pdf = await generarPDF(comandas.map((c) => ticketCocina(c, momento())), 'Tickets de cocina');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="tickets-${comandas.map((c) => c.numero_dia).join('-')}.pdf"`);
    res.end(pdf);
  })
);

app.post(
  '/api/tickets/impresos',
  ruta((req) => {
    const ids = listaIds(req.body.ids);
    if (!ids.length) fail(400, 'Sin tickets');
    const upd = db.prepare('UPDATE comandas SET ticket_impreso = 1, ticket_modificado = 0 WHERE id = ?');
    tx(() => ids.forEach((id) => upd.run(id)));
    emitir('comandas', { accion: 'impreso', ids });
    return { ok: true };
  })
);

// ---------------- ticketera térmica (ESC/POS) ----------------
// Al imprimirse un ticket de cocina, la comanda deja de estar "pendiente de impresión"
impresora.configurar({
  emitir,
  alImprimir: (t) => {
    if (t.tipo !== 'comanda' || !t.ref) return;
    db.prepare('UPDATE comandas SET ticket_impreso = 1, ticket_modificado = 0 WHERE id = ?').run(t.ref);
    emitir('comandas', { accion: 'impreso', ids: [t.ref] });
  },
});

function opcionesTicketera() {
  const a = impresora.ajustes();
  return { columnas: a.columnas, pagina: a.pagina, cortar: a.cortar, logo: a.logo, nombre: CONFIG.nombreRestaurante };
}
const lugarCorto = (c) => (c.tipo === 'local' ? `Mesa ${c.mesa_numero ?? '?'}` : `Llevar${c.cliente ? ` ${c.cliente}` : ''}`);

/** Manda a la ticketera el ticket de cocina de cada comanda (reemplaza el que estuviera en cola) */
function imprimirTicketsCocina(comandas) {
  const a = impresora.ajustes();
  for (const c of comandas) {
    impresora.descartarPendientes('comanda', c.id);
    const datos = documentoESCPOS([ticketCocina(c, momento())], opcionesTicketera());
    impresora.encolar('comanda', c.id, `Comanda #${c.numero_dia} · ${lugarCorto(c)}${c.ticket_modificado ? ' (modificada)' : ''}`, datos, a.copiasComanda);
  }
}

/** Impresión automática al enviar a cocina (o al modificar una comanda que ya estaba en cocina) */
function ticketsAutomaticos(id) {
  const a = impresora.ajustes();
  if (a.modo === 'ninguna' || !a.autoComandas) return;
  const c = obtenerComanda(id);
  if (c && EN_COCINA.includes(c.estado) && !c.ticket_impreso) imprimirTicketsCocina([c]);
}

const exigirTicketera = () => {
  if (!impresora.activa()) fail(400, 'No hay ticketera configurada (Gestión → Impresora)');
};

app.get('/api/impresora/estado', ruta(() => impresora.resumen()));

app.get(
  '/api/impresora',
  rol('admin', 'caja'),
  ruta(() => ({ ajustes: impresora.ajustes(), estado: impresora.resumen(), cola: impresora.cola(), windows: process.platform === 'win32' }))
);

app.put(
  '/api/impresora',
  rol('admin'),
  ruta((req) => {
    try {
      return impresora.guardarAjustes(req.body || {});
    } catch (e) {
      fail(400, e.message);
    }
  })
);

app.get(
  '/api/impresora/dispositivos',
  rol('admin'),
  ruta(async () => {
    try {
      return await impresora.dispositivos();
    } catch (e) {
      fail(500, `No se pudieron buscar dispositivos: ${e.message}`);
    }
  })
);

app.post(
  '/api/impresora/prueba',
  rol('admin', 'caja'),
  ruta(() => {
    exigirTicketera();
    impresora.encolar('prueba', null, 'Ticket de prueba', documentoPrueba(opcionesTicketera(), CONFIG.nombreRestaurante, momento()));
    return { ok: true };
  })
);

app.post(
  '/api/impresora/reintentar',
  rol('admin', 'caja', 'cocina'),
  ruta((req) => {
    impresora.reintentar(req.body?.id ? Number(req.body.id) : null);
    return impresora.resumen();
  })
);

app.post(
  '/api/impresora/cancelar',
  rol('admin', 'caja'),
  ruta((req) => {
    impresora.cancelar(Number(req.body?.id));
    return impresora.resumen();
  })
);

// Imprimir (o reimprimir) tickets de cocina en la ticketera. { ids: [comandas] }
app.post(
  '/api/imprimir/comanda',
  rol('admin', 'caja', 'cocina', 'mozo'),
  ruta((req) => {
    exigirTicketera();
    const comandas = obtenerComandas(listaIds(req.body?.ids)).filter((c) => c.estado !== 'generado' && c.estado !== 'cancelado');
    if (!comandas.length) fail(404, 'No hay tickets para imprimir');
    imprimirTicketsCocina(comandas);
    return { ok: true, enCola: comandas.length };
  })
);

// Precuenta en la ticketera. { ids: [comandas] }
app.post(
  '/api/imprimir/precuenta',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    exigirTicketera();
    const comandas = obtenerComandas(listaIds(req.body?.ids)).filter((c) => c.estado !== 'cancelado' && !c.pagada);
    if (!comandas.length) fail(404, 'No hay consumo pendiente para la precuenta');
    const datos = documentoESCPOS([comprobante({ comandas, config: CONFIG, ahora: ahora() })], opcionesTicketera());
    impresora.encolar('precuenta', comandas[0].id, `Precuenta · ${lugarCorto(comandas[0])}`, datos);
    return { ok: true };
  })
);

// Comprobante de un cobro en la ticketera. { cobro_id }
app.post(
  '/api/imprimir/comprobante',
  rol('admin', 'caja'),
  ruta((req) => {
    exigirTicketera();
    const id = Number(req.body?.cobro_id);
    const cobro = db.prepare('SELECT * FROM cobros WHERE id = ?').get(id);
    if (!cobro) fail(404, 'Cobro no encontrado');
    if (cobro.anulado) fail(400, 'Este cobro fue anulado');
    const ids = db.prepare('SELECT id FROM comandas WHERE cobro_id = ?').all(id).map((r) => r.id);
    const cajero = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(cobro.usuario_id)?.nombre;
    const datos = documentoESCPOS([comprobante({ cobro, comandas: obtenerComandas(ids), config: CONFIG, cajero })], opcionesTicketera());
    impresora.encolar('comprobante', id, `Comprobante N° ${String(id).padStart(6, '0')}`, datos);
    return { ok: true };
  })
);

// ---------------- cobros y comprobante ----------------
app.post(
  '/api/cobros',
  rol('admin', 'caja'),
  ruta((req) => {
    const ids = listaIds(req.body.comanda_ids);
    if (!ids.length) fail(400, 'Seleccione qué cobrar');
    const comandas = obtenerComandas(ids);
    if (comandas.length !== ids.length) fail(404, 'Comanda no encontrada');
    for (const c of comandas) {
      if (c.estado === 'cancelado') fail(400, `La comanda #${c.numero_dia} está cancelada`);
      if (c.pagada) fail(400, `La comanda #${c.numero_dia} ya fue cobrada`);
    }
    const metodo = METODOS_PAGO.includes(req.body.metodo) ? req.body.metodo : fail(400, 'Elija la forma de pago');
    const tipoComprobante = req.body.comprobante === 'sunat' ? 'sunat' : 'nota';
    const total = redondear(comandas.reduce((s, c) => s + c.total, 0));
    // boleta/factura ya emitida en SOL: su XML viene con el cobro y se vincula en el mismo paso
    const xmlSunat = tipoComprobante === 'sunat' && req.body.sunat_xml ? leerXMLSubido(req.body.sunat_xml) : null;
    if (xmlSunat) {
      const usado = vinculoExistente(xmlSunat.d);
      if (usado) fail(409, usado);
      if (Math.abs(xmlSunat.d.totales.total - total) >= 0.01 && !req.body.aceptar_diferencia)
        fail(409, `El total de la ${nombreCorto(xmlSunat.d)} (${xmlSunat.d.totales.total.toFixed(2)}) no coincide con el cobro (${total.toFixed(2)})`);
    }
    let recibido = null;
    if (metodo === 'Efectivo' && req.body.recibido !== undefined && req.body.recibido !== null && req.body.recibido !== '') {
      recibido = redondear(Number(req.body.recibido));
      if (!Number.isFinite(recibido) || recibido < total) fail(400, 'El monto recibido es menor al total');
    }
    const cobroId = tx(() => {
      const id = db
        .prepare('INSERT INTO cobros (fecha, total, metodo, recibido, usuario_id, creado_en, comprobante) VALUES (?,?,?,?,?,?,?)')
        .run(hoy(), total, metodo, recibido, req.user.id, ahora(), tipoComprobante).lastInsertRowid;
      const upd = db.prepare('UPDATE comandas SET pagada = 1, cobro_id = ?, actualizado_en = ? WHERE id = ?');
      ids.forEach((cid) => upd.run(id, ahora(), cid));
      // mesa unida sin nada pendiente: se separa sola
      for (const mesaId of new Set(comandas.map((c) => c.mesa_id).filter(Boolean))) {
        const pendiente = db
          .prepare("SELECT 1 FROM comandas WHERE mesa_id = ? AND pagada = 0 AND estado <> 'cancelado' LIMIT 1")
          .get(mesaId);
        if (!pendiente) separarGrupo(mesaId);
      }
      if (xmlSunat) {
        const { comprobante: comp } = sunat.registrar(xmlSunat.d, xmlSunat.xml, req.user.id, ahora());
        sunat.vincular(comp.id, id);
      }
      return id;
    });
    emitir('mesas');
    ids.forEach((cid) => notificarComanda(cid, 'pago'));
    const sunatId = db.prepare('SELECT id FROM comprobantes_sunat WHERE cobro_id = ?').get(cobroId)?.id ?? null;
    return { ...db.prepare('SELECT * FROM cobros WHERE id = ?').get(cobroId), sunat_id: sunatId };
  })
);

app.post(
  '/api/cobros/:id/anular',
  rol('admin', 'caja'),
  ruta((req) => {
    const id = Number(req.params.id);
    const cobro = db.prepare('SELECT * FROM cobros WHERE id = ?').get(id);
    if (!cobro || cobro.anulado) fail(404, 'Cobro no encontrado');
    const ids = db.prepare('SELECT id FROM comandas WHERE cobro_id = ?').all(id).map((r) => r.id);
    tx(() => {
      db.prepare('UPDATE cobros SET anulado = 1 WHERE id = ?').run(id);
      db.prepare('UPDATE comandas SET pagada = 0, cobro_id = NULL WHERE cobro_id = ?').run(id);
    });
    ids.forEach((cid) => notificarComanda(cid, 'pago'));
    return { ok: true };
  })
);

// Precuenta: lo que va consumiendo la mesa, antes de cobrar. ?ids=1,2 (comandas)
app.get(
  '/api/precuenta.pdf',
  rol('admin', 'mozo', 'caja'),
  ruta(async (req, res) => {
    const comandas = obtenerComandas(listaIds(req.query.ids)).filter((c) => c.estado !== 'cancelado' && !c.pagada);
    if (!comandas.length) fail(404, 'No hay consumo pendiente para la precuenta');
    const pdf = await generarPDF([comprobante({ comandas, config: CONFIG, ahora: ahora() })], 'Precuenta');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="precuenta-${comandas.map((c) => c.numero_dia).join('-')}.pdf"`);
    res.end(pdf);
  })
);

app.get(
  '/api/cobros/:id/comprobante.pdf',
  rol('admin', 'caja'),
  ruta(async (req, res) => {
    const id = Number(req.params.id);
    const cobro = db.prepare('SELECT * FROM cobros WHERE id = ?').get(id);
    if (!cobro) fail(404, 'Cobro no encontrado');
    if (cobro.anulado) fail(400, 'Este cobro fue anulado');
    const ids = db.prepare('SELECT id FROM comandas WHERE cobro_id = ?').all(id).map((r) => r.id);
    const cajero = db.prepare('SELECT nombre FROM usuarios WHERE id = ?').get(cobro.usuario_id)?.nombre;
    const pdf = await generarPDF([comprobante({ cobro, comandas: obtenerComandas(ids), config: CONFIG, cajero })], 'Comprobante de pago');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="comprobante-${String(id).padStart(6, '0')}.pdf"`);
    res.end(pdf);
  })
);

// ---------------- comprobantes SUNAT (boletas y facturas emitidas en SOL) ----------------
// Datos de un cobro para listarlo: comandas, mesa o cliente
const SQL_COBRO = `
  SELECT co.id, co.fecha, co.total, co.metodo, co.comprobante, co.creado_en, co.anulado,
    (SELECT group_concat('#' || c.numero_dia, ', ') FROM comandas c WHERE c.cobro_id = co.id) AS comandas,
    (SELECT CASE WHEN c.tipo = 'local' THEN 'Mesa ' || COALESCE(NULLIF(c.mesa_etiqueta, ''), m.numero)
                 ELSE 'Para llevar' || CASE WHEN c.cliente <> '' THEN ' · ' || c.cliente ELSE '' END END
       FROM comandas c LEFT JOIN mesas m ON m.id = c.mesa_id WHERE c.cobro_id = co.id LIMIT 1) AS lugar
  FROM cobros co`;

const qrDe = (d) => sunat.textoQR(d);

app.get(
  '/api/sunat',
  rol('admin', 'caja'),
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    const pendientes = db
      .prepare(
        `${SQL_COBRO} WHERE co.fecha = ? AND co.anulado = 0 AND co.comprobante = 'sunat'
           AND NOT EXISTS (SELECT 1 FROM comprobantes_sunat s WHERE s.cobro_id = co.id) ORDER BY co.id DESC`
      )
      .all(fecha);
    const comprobantes = db
      .prepare(
        `SELECT s.id, s.cobro_id, s.tipo, s.serie, s.numero, s.fecha, s.hora, s.cliente_tipo_doc, s.cliente_doc, s.cliente_nombre,
           s.total, s.subido_en, co.anulado AS cobro_anulado,
           (SELECT group_concat('#' || c.numero_dia, ', ') FROM comandas c WHERE c.cobro_id = s.cobro_id) AS comandas
         FROM comprobantes_sunat s LEFT JOIN cobros co ON co.id = s.cobro_id
         WHERE s.fecha = ? OR substr(s.subido_en, 1, 10) = ? ORDER BY s.id DESC`
      )
      .all(fecha, fecha);
    return { fecha, pendientes, comprobantes, ruc: CONFIG.ruc || '' };
  })
);

// Detalle de los platos de un cobro, para copiarlos en SOL
app.get(
  '/api/sunat/cobro/:id',
  rol('admin', 'caja'),
  ruta((req) => {
    const cobro = db.prepare(`${SQL_COBRO} WHERE co.id = ?`).get(Number(req.params.id));
    if (!cobro) fail(404, 'Cobro no encontrado');
    const ids = db.prepare('SELECT id FROM comandas WHERE cobro_id = ?').all(cobro.id).map((r) => r.id);
    return { cobro, comandas: obtenerComandas(ids) };
  })
);

const nombreCorto = (d) => `${d.tipo === '01' ? 'factura' : 'boleta'} ${d.serie}-${d.numero}`;

/** Lee el XML o ZIP subido (base64). Error 400 con un mensaje claro si no es una boleta o factura. */
function leerXMLSubido(base64) {
  const contenido = Buffer.from(String(base64 || ''), 'base64');
  if (!contenido.length) fail(400, 'Elija el archivo XML o ZIP descargado de SUNAT');
  try {
    return { d: sunat.leerComprobante(contenido), xml: sunat.extraerXML(contenido) };
  } catch (e) {
    fail(400, `No se pudo leer el archivo: ${e.message}`);
  }
}

/** Si ese comprobante ya está vinculado a un cobro, devuelve el motivo para no usarlo otra vez */
function vinculoExistente(d) {
  const previo = db
    .prepare('SELECT cobro_id FROM comprobantes_sunat WHERE ruc_emisor = ? AND tipo = ? AND serie = ? AND numero = ? AND cobro_id IS NOT NULL')
    .get(d.emisor.ruc, d.tipo, d.serie, d.numero);
  if (!previo) return null;
  const cobro = db.prepare(`${SQL_COBRO} WHERE co.id = ?`).get(previo.cobro_id);
  return `La ${nombreCorto(d)} ya está registrada en otro cobro${cobro ? ` (${cobro.lugar || ''} ${cobro.comandas || ''}, ${cobro.creado_en.slice(11, 16)})` : ''}`;
}

// Vista previa del XML antes de cobrar (no guarda nada). { contenido (base64), total? }
app.post(
  '/api/sunat/leer',
  rol('admin', 'caja'),
  ruta((req) => {
    const { d } = leerXMLSubido(req.body?.contenido);
    const usado = vinculoExistente(d);
    if (usado) fail(409, usado);
    const avisos = [];
    if (CONFIG.ruc && d.emisor.ruc && d.emisor.ruc !== CONFIG.ruc)
      avisos.push(`Es del RUC ${d.emisor.ruc}, distinto al del local (${CONFIG.ruc}).`);
    if (d.fecha !== hoy()) avisos.push(`Fue emitida el ${d.fecha.split('-').reverse().join('/')}, no hoy.`);
    const total = Number(req.body?.total);
    return {
      tipo: d.tipo,
      tipoTexto: d.tipoTexto,
      numero: `${d.serie}-${d.numero}`,
      fecha: d.fecha,
      cliente: { tipoDocTexto: d.cliente.tipoDocTexto, doc: /^-+$/.test(d.cliente.doc) ? '' : d.cliente.doc, nombre: /^-+$/.test(d.cliente.nombre) ? '' : d.cliente.nombre },
      items: d.items.length,
      total: d.totales.total,
      coincide: Number.isFinite(total) ? Math.abs(total - d.totales.total) < 0.01 : null,
      avisos,
    };
  })
);

// Subir el XML (o el ZIP) descargado de SOL. { nombre, contenido (base64), cobro_id? }
app.post(
  '/api/sunat/xml',
  rol('admin', 'caja'),
  ruta((req) => {
    const contenido = Buffer.from(String(req.body?.contenido || ''), 'base64');
    if (!contenido.length) fail(400, 'Elija el archivo XML descargado de SUNAT');
    let d;
    try {
      d = sunat.leerComprobante(contenido);
    } catch (e) {
      fail(400, `No se pudo leer el archivo: ${e.message}`);
    }
    const avisos = [];
    if (CONFIG.ruc && d.emisor.ruc && d.emisor.ruc !== CONFIG.ruc)
      avisos.push(`El comprobante es del RUC ${d.emisor.ruc}, distinto al del local (${CONFIG.ruc}).`);
    const xml = sunat.extraerXML(contenido);
    const { comprobante: comp, repetido } = sunat.registrar(d, xml, req.user.id, ahora());
    if (repetido) avisos.push(`El comprobante ${comp.serie}-${comp.numero} ya se había subido.`);

    // vincular con el cobro: el indicado, o el único que coincide en fecha y total
    let cobro = comp.cobro_id ? db.prepare(`${SQL_COBRO} WHERE co.id = ?`).get(comp.cobro_id) : null;
    let candidatos = [];
    if (!cobro) {
      const pedido = Number(req.body?.cobro_id) || null;
      if (pedido) {
        cobro = db.prepare(`${SQL_COBRO} WHERE co.id = ? AND co.anulado = 0`).get(pedido);
        if (!cobro) fail(404, 'Cobro no encontrado o anulado');
        if (Math.abs(cobro.total - d.totales.total) >= 0.01)
          avisos.push(`El total del comprobante (${d.totales.total.toFixed(2)}) no coincide con el cobro (${cobro.total.toFixed(2)}).`);
      } else {
        candidatos = sunat.candidatos(d).map((c) => db.prepare(`${SQL_COBRO} WHERE co.id = ?`).get(c.id));
        if (candidatos.length === 1) [cobro] = candidatos;
      }
      if (cobro) sunat.vincular(comp.id, cobro.id);
    }
    if (cobro) emitir('comandas', { accion: 'sunat', cobro_id: cobro.id });
    return {
      comprobante: sunat.obtener(comp.id),
      resumen: { tipo: d.tipoTexto, numero: `${d.serie}-${d.numero}`, cliente: d.cliente.nombre, total: d.totales.total },
      repetido,
      cobro: cobro || null,
      candidatos: cobro ? [] : candidatos,
      avisos,
    };
  })
);

app.post(
  '/api/sunat/:id/vincular',
  rol('admin', 'caja'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (!sunat.obtener(id)) fail(404, 'Comprobante no encontrado');
    const cobroId = Number(req.body?.cobro_id) || null;
    if (cobroId && !db.prepare('SELECT 1 FROM cobros WHERE id = ? AND anulado = 0').get(cobroId)) fail(404, 'Cobro no encontrado o anulado');
    const r = sunat.vincular(id, cobroId);
    emitir('comandas', { accion: 'sunat', cobro_id: cobroId });
    return r;
  })
);

app.delete(
  '/api/sunat/:id',
  rol('admin'),
  ruta((req) => {
    sunat.eliminar(Number(req.params.id));
    emitir('comandas', { accion: 'sunat' });
    return { ok: true };
  })
);

app.get(
  '/api/sunat/:id/comprobante.pdf',
  rol('admin', 'caja'),
  ruta(async (req, res) => {
    const d = sunat.datos(Number(req.params.id));
    if (!d) fail(404, 'Comprobante no encontrado');
    const pdf = await generarPDF([comprobanteSunat(d, CONFIG, qrDe(d))], `${d.serie}-${d.numero}`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${d.serie}-${d.numero}.pdf"`);
    res.end(pdf);
  })
);

app.get(
  '/api/sunat/:id/xml',
  rol('admin', 'caja'),
  ruta((req, res) => {
    const f = sunat.rutaXML(Number(req.params.id));
    if (!f || !fs.existsSync(f)) fail(404, 'Archivo no encontrado');
    res.download(f);
  })
);

// Imprimir el comprobante SUNAT en la ticketera. { id }
app.post(
  '/api/imprimir/sunat',
  rol('admin', 'caja'),
  ruta((req) => {
    exigirTicketera();
    const d = sunat.datos(Number(req.body?.id));
    if (!d) fail(404, 'Comprobante no encontrado');
    impresora.encolar('comprobante', Number(req.body.id), `${d.tipo === '01' ? 'Factura' : 'Boleta'} ${d.serie}-${d.numero}`,
      documentoESCPOS([comprobanteSunat(d, CONFIG, qrDe(d))], opcionesTicketera()));
    return { ok: true };
  })
);

// ---------------- reporte del día ----------------
app.get(
  '/api/reportes/dia',
  rol('admin', 'caja'),
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    const validas = "c.fecha = ? AND c.estado <> 'cancelado'";

    const resumen = db
      .prepare(
        `SELECT COUNT(*) AS comandas,
          COALESCE(SUM(c.total),0) AS total_vendido,
          COALESCE(SUM(CASE WHEN c.pagada = 1 THEN c.total ELSE 0 END),0) AS total_cobrado,
          COUNT(DISTINCT c.mesa_id) AS mesas_atendidas,
          COALESCE(SUM(CASE WHEN c.tipo = 'local' THEN 1 ELSE 0 END),0) AS en_mesa,
          COALESCE(SUM(CASE WHEN c.tipo = 'llevar' THEN 1 ELSE 0 END),0) AS para_llevar
         FROM comandas c WHERE ${validas}`
      )
      .get(fecha);
    resumen.canceladas = db.prepare("SELECT COUNT(*) AS n FROM comandas WHERE fecha = ? AND estado = 'cancelado'").get(fecha).n;
    resumen.ticket_promedio = resumen.comandas ? resumen.total_vendido / resumen.comandas : 0;

    const porEstado = db
      .prepare(
        `SELECT CASE WHEN estado IN ('en_proceso','esperando_entrega') THEN 'enviado_cocina' ELSE estado END AS estado,
           COUNT(*) AS cantidad FROM comandas WHERE fecha = ? GROUP BY 1`
      )
      .all(fecha);

    const porMozo = db
      .prepare(
        `SELECT COALESCE(u.nombre,'(sin mozo)') AS mozo, COUNT(*) AS comandas, COUNT(DISTINCT c.mesa_id) AS mesas,
           COALESCE(SUM(c.total),0) AS total
         FROM comandas c LEFT JOIN usuarios u ON u.id = c.mozo_id
         WHERE ${validas} GROUP BY c.mozo_id ORDER BY total DESC`
      )
      .all(fecha);

    const mesas = db
      .prepare(
        `SELECT m.numero AS mesa, COUNT(*) AS comandas, COALESCE(SUM(c.total),0) AS total
         FROM comandas c JOIN mesas m ON m.id = c.mesa_id WHERE ${validas}
         GROUP BY c.mesa_id ORDER BY CAST(m.numero AS INTEGER), m.numero`
      )
      .all(fecha);

    const productos = db
      .prepare(
        `SELECT i.nombre, i.tipo, SUM(i.cantidad) AS cantidad, SUM(i.cantidad * i.precio) AS total
         FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id WHERE ${validas}
         GROUP BY i.nombre, i.tipo ORDER BY cantidad DESC LIMIT 15`
      )
      .all(fecha);

    const guarniciones = db
      .prepare(
        `SELECT g.nombre, SUM(g.cantidad) AS cantidad FROM (
           SELECT i.guarnicion_eleccion AS nombre, i.cantidad FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id
             WHERE ${validas} AND i.guarnicion_eleccion <> ''
           UNION ALL
           SELECT i.guarnicion_base AS nombre, i.cantidad FROM comanda_items i JOIN comandas c ON c.id = i.comanda_id
             WHERE ${validas} AND i.guarnicion_base <> ''
         ) g GROUP BY g.nombre ORDER BY cantidad DESC`
      )
      .all(fecha, fecha);

    const pagos = db
      .prepare(
        `SELECT metodo, COUNT(*) AS cobros, COALESCE(SUM(total),0) AS total
         FROM cobros WHERE fecha = ? AND anulado = 0 GROUP BY metodo ORDER BY total DESC`
      )
      .all(fecha);

    const empleados = db
      .prepare(
        `SELECT u.nombre, u.rol, MIN(t.inicio) AS inicio,
           CASE WHEN SUM(t.fin IS NULL) > 0 THEN NULL ELSE MAX(t.fin) END AS fin
         FROM turnos t JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.fecha = ? GROUP BY t.usuario_id ORDER BY u.rol, u.nombre`
      )
      .all(fecha);

    // Tiempo promedio desde que se envía a cocina hasta que se entrega, en minutos
    const tiempos = db
      .prepare(
        `SELECT AVG((julianday(l.fecha) - julianday(e.fecha)) * 1440) AS prom_entrega
         FROM comandas c
         JOIN (SELECT comanda_id, MIN(fecha) AS fecha FROM comanda_historial WHERE estado = 'enviado_cocina' GROUP BY comanda_id) e ON e.comanda_id = c.id
         JOIN (SELECT comanda_id, MAX(fecha) AS fecha FROM comanda_historial WHERE estado = 'entregado' GROUP BY comanda_id) l ON l.comanda_id = c.id
         WHERE ${validas}`
      )
      .get(fecha);

    return {
      fecha,
      resumen: { ...resumen, empleados_en_turno: empleados.length, tiempo_promedio_entrega: tiempos.prom_entrega },
      porEstado,
      porMozo,
      mesas,
      productos,
      guarniciones,
      pagos,
      empleados,
    };
  })
);

// ---------------- archivos estáticos y errores ----------------
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
});

// ---------------- arranque ----------------
if (sembrar()) {
  console.log('Base de datos creada con datos de ejemplo. Usuario inicial: admin / admin123');
  try {
    const r = cargarCarta(leerCarta());
    console.log(`Carta inicial cargada: ${r.platosCreados} platos y ${r.guarnicionesCreadas} guarniciones`);
  } catch (e) {
    console.error('No se pudo cargar la carta inicial:', e.message);
  }
}
try {
  console.log('Respaldo del día:', respaldar(CONFIG.diasRespaldo));
} catch (e) {
  console.error('No se pudo crear el respaldo:', e.message);
}
setInterval(() => {
  try {
    respaldar(CONFIG.diasRespaldo);
  } catch (e) {
    console.error('Respaldo fallido:', e.message);
  }
}, 60 * 60 * 1000).unref();

app.listen(PUERTO, '0.0.0.0', () => {
  console.log(`\n=== ${CONFIG.nombreRestaurante} - Sistema de comandas ===`);
  console.log(`En esta PC:      http://localhost:${PUERTO}`);
  for (const d of direccionesRed()) console.log(`Desde celulares: ${d.url}   (${d.interfaz})`);
  console.log('');
});
