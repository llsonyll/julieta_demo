// Servidor de comandas - red local
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const express = require('express');
const { db, tx, hoy, ahora, hashPassword, verificarPassword, sembrar, respaldar } = require('./db');

const CONFIG = Object.assign(
  { puerto: 3000, nombreRestaurante: 'Mi Restaurante', moneda: 'S/', diasRespaldo: 30 },
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'))
);
const PUERTO = Number(process.env.PORT || CONFIG.puerto);

const ROLES = ['admin', 'mozo', 'caja', 'cocina'];
const ESTADOS = ['generado', 'enviado_cocina', 'en_proceso', 'esperando_entrega', 'entregado', 'cancelado'];
// Transiciones permitidas: estado actual -> { nuevo estado: roles que pueden hacerlo }
// (el admin puede forzar cualquier cambio)
const TRANSICIONES = {
  generado: { enviado_cocina: ['mozo', 'caja'], cancelado: ['mozo', 'caja'] },
  enviado_cocina: { en_proceso: ['cocina'], cancelado: ['caja'] },
  en_proceso: { esperando_entrega: ['cocina'], enviado_cocina: ['cocina'] },
  esperando_entrega: { entregado: ['mozo', 'caja'], en_proceso: ['cocina'] },
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
    if (r !== undefined) res.json(r);
  } catch (e) {
    next(e);
  }
};
const esFecha = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);

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
  req.user = u;
  req.token = token;
  next();
}
const rol = (...roles) => (req, res, next) =>
  roles.includes(req.user.rol) ? next() : next(new HttpError(403, 'No tiene permiso para esta acción'));

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
  return db
    .prepare('SELECT * FROM turnos WHERE usuario_id = ? AND fin IS NULL AND fecha = ?')
    .get(usuarioId, hoy()) || null;
}

app.post(
  '/api/login',
  ruta((req, res) => {
    const usuario = texto(req.body.usuario, 50);
    const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1').get(usuario);
    if (!u || !verificarPassword(req.body.password ?? '', u.password_hash)) fail(401, 'Usuario o contraseña incorrectos');
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sesiones (token, usuario_id, creado_en) VALUES (?,?,?)').run(token, u.id, ahora());
    const turno = abrirTurno(u.id);
    emitir('turnos');
    res.setHeader(
      'Set-Cookie',
      `token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`
    );
    return { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, turno };
  })
);

app.get('/api/config', (req, res) =>
  res.json({ nombreRestaurante: CONFIG.nombreRestaurante, moneda: CONFIG.moneda, estados: ESTADOS, ahora: ahora(), hoy: hoy() })
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
          (SELECT COUNT(*) FROM mesas m WHERE m.mozo_id = usuarios.id) AS mesas_asignadas,
          EXISTS (SELECT 1 FROM turnos t WHERE t.usuario_id = usuarios.id AND t.fin IS NULL AND t.fecha = ?) AS en_turno
         FROM usuarios ORDER BY activo DESC, rol, nombre`
      )
      .all(hoy())
  )
);

function validarUsuario(b, nuevo) {
  const nombre = texto(b.nombre, 80);
  const usuario = texto(b.usuario, 40).toLowerCase();
  if (!nombre) fail(400, 'El nombre es obligatorio');
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) fail(400, 'Usuario: 3 a 40 caracteres (letras, números, . _ -)');
  if (!ROLES.includes(b.rol)) fail(400, 'Rol inválido');
  if (nuevo && String(b.password ?? '').length < 4) fail(400, 'La contraseña debe tener al menos 4 caracteres');
  if (!nuevo && b.password && String(b.password).length < 4) fail(400, 'La contraseña debe tener al menos 4 caracteres');
  return { nombre, usuario, rol: b.rol, activo: b.activo === undefined ? 1 : bool(b.activo) };
}
function existeUsuario(usuario, exceptoId = 0) {
  return db.prepare('SELECT 1 FROM usuarios WHERE usuario = ? AND id <> ?').get(usuario, exceptoId);
}

app.post(
  '/api/usuarios',
  rol('admin'),
  ruta((req) => {
    const u = validarUsuario(req.body, true);
    if (existeUsuario(u.usuario)) fail(409, 'Ese nombre de usuario ya existe');
    const id = db
      .prepare('INSERT INTO usuarios (nombre, usuario, password_hash, rol, activo, creado_en) VALUES (?,?,?,?,?,?)')
      .run(u.nombre, u.usuario, hashPassword(req.body.password), u.rol, u.activo, ahora()).lastInsertRowid;
    return db.prepare(`SELECT ${COLS_USUARIO} FROM usuarios WHERE id = ?`).get(id);
  })
);

app.put(
  '/api/usuarios/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    const actual = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
    if (!actual) fail(404, 'Usuario no encontrado');
    const u = validarUsuario(req.body, false);
    if (existeUsuario(u.usuario, id)) fail(409, 'Ese nombre de usuario ya existe');
    if (id === req.user.id && (u.rol !== 'admin' || !u.activo)) fail(400, 'No puede quitarse el rol de admin ni desactivarse a sí mismo');
    db.prepare('UPDATE usuarios SET nombre=?, usuario=?, rol=?, activo=? WHERE id=?').run(u.nombre, u.usuario, u.rol, u.activo, id);
    if (req.body.password) db.prepare('UPDATE usuarios SET password_hash=? WHERE id=?').run(hashPassword(req.body.password), id);
    if (!u.activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
    if (u.rol !== 'mozo') db.prepare('UPDATE mesas SET mozo_id = NULL WHERE mozo_id = ?').run(id);
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
      // Se conserva para no perder la historia de comandas
      db.prepare('UPDATE usuarios SET activo = 0 WHERE id = ?').run(id);
      db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id);
      db.prepare('UPDATE mesas SET mozo_id = NULL WHERE mozo_id = ?').run(id);
      emitir('mesas');
      return { ok: true, desactivado: true };
    }
    db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
    emitir('mesas');
    return { ok: true };
  })
);

app.get(
  '/api/mozos',
  rol('admin', 'caja'),
  ruta(() => db.prepare("SELECT id, nombre FROM usuarios WHERE rol = 'mozo' AND activo = 1 ORDER BY nombre").all())
);

// ---------------- mesas ----------------
function listarMesas(filtroMozo) {
  const filas = db
    .prepare(
      `SELECT m.*, u.nombre AS mozo_nombre,
        (SELECT COUNT(*) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado <> 'cancelado' AND c.pagada = 0) AS comandas_abiertas,
        (SELECT COUNT(*) FROM comandas c WHERE c.mesa_id = m.id AND c.fecha = ?
           AND c.estado = 'esperando_entrega') AS listas
       FROM mesas m LEFT JOIN usuarios u ON u.id = m.mozo_id
       ${filtroMozo ? 'WHERE m.activa = 1 AND m.mozo_id = ?' : ''}
       ORDER BY CAST(m.numero AS INTEGER), m.numero`
    )
    .all(...[hoy(), hoy(), ...(filtroMozo ? [filtroMozo] : [])]);
  return filas.map((m) => ({ ...m, ocupada: m.comandas_abiertas > 0 }));
}

app.get(
  '/api/mesas',
  ruta((req) => {
    if (req.user.rol === 'mozo' && req.query.todas !== '1') {
      const propias = listarMesas(req.user.id);
      // si el mozo no tiene mesas asignadas, ve todas las activas
      if (propias.length) return propias;
      return listarMesas().filter((m) => m.activa);
    }
    const todas = listarMesas();
    return req.user.rol === 'admin' ? todas : todas.filter((m) => m.activa);
  })
);

function validarMesa(b) {
  const numero = texto(b.numero, 20);
  if (!numero) fail(400, 'El número/nombre de mesa es obligatorio');
  const capacidad = Math.max(1, Math.min(50, parseInt(b.capacidad, 10) || 4));
  let mozo_id = b.mozo_id ? Number(b.mozo_id) : null;
  if (mozo_id && !db.prepare("SELECT 1 FROM usuarios WHERE id = ? AND rol = 'mozo'").get(mozo_id)) fail(400, 'El mozo no existe');
  return { numero, capacidad, mozo_id, activa: b.activa === undefined ? 1 : bool(b.activa) };
}

app.post(
  '/api/mesas',
  rol('admin'),
  ruta((req) => {
    const m = validarMesa(req.body);
    if (db.prepare('SELECT 1 FROM mesas WHERE numero = ?').get(m.numero)) fail(409, 'Ya existe una mesa con ese número');
    const id = db
      .prepare('INSERT INTO mesas (numero, capacidad, mozo_id, activa) VALUES (?,?,?,?)')
      .run(m.numero, m.capacidad, m.mozo_id, m.activa).lastInsertRowid;
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
    db.prepare('UPDATE mesas SET numero=?, capacidad=?, mozo_id=?, activa=? WHERE id=?').run(m.numero, m.capacidad, m.mozo_id, m.activa, id);
    emitir('mesas');
    return db.prepare('SELECT * FROM mesas WHERE id = ?').get(id);
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
    emitir('mesas');
    return { ok: true };
  })
);

// ---------------- menú del día y extras ----------------
app.get(
  '/api/productos',
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    const where = [];
    const params = [];
    if (req.query.tipo === 'menu') {
      where.push("tipo = 'menu' AND fecha = ?");
      params.push(fecha);
    } else if (req.query.tipo === 'extra') {
      where.push("tipo = 'extra'");
    } else {
      // carta vigente: menú de la fecha + extras
      where.push("((tipo = 'menu' AND fecha = ?) OR tipo = 'extra')");
      params.push(fecha);
    }
    if (req.user.rol !== 'admin' || req.query.vigentes === '1') where.push('activo = 1');
    return db
      .prepare(`SELECT * FROM productos WHERE ${where.join(' AND ')} ORDER BY tipo DESC, categoria, nombre`)
      .all(...params);
  })
);

function validarProducto(b) {
  const nombre = texto(b.nombre, 120);
  if (!nombre) fail(400, 'El nombre es obligatorio');
  const tipo = b.tipo === 'menu' ? 'menu' : b.tipo === 'extra' ? 'extra' : fail(400, 'Tipo inválido');
  const precio = Number(b.precio);
  if (!Number.isFinite(precio) || precio < 0) fail(400, 'Precio inválido');
  const fecha = tipo === 'menu' ? (esFecha(b.fecha) ? b.fecha : hoy()) : null;
  const p = {
    nombre,
    descripcion: texto(b.descripcion, 300),
    categoria: texto(b.categoria, 40),
    precio: Math.round(precio * 100) / 100,
    tipo,
    fecha,
    para_local: b.para_local === undefined ? 1 : bool(b.para_local),
    para_llevar: b.para_llevar === undefined ? 1 : bool(b.para_llevar),
    disponible: b.disponible === undefined ? 1 : bool(b.disponible),
    activo: b.activo === undefined ? 1 : bool(b.activo),
  };
  if (!p.para_local && !p.para_llevar) fail(400, 'Debe estar disponible para mesa y/o para llevar');
  return p;
}

app.post(
  '/api/productos',
  rol('admin'),
  ruta((req) => {
    const p = validarProducto(req.body);
    const id = db
      .prepare(
        `INSERT INTO productos (nombre, descripcion, categoria, precio, tipo, fecha, para_local, para_llevar, disponible, activo)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      )
      .run(p.nombre, p.descripcion, p.categoria, p.precio, p.tipo, p.fecha, p.para_local, p.para_llevar, p.disponible, p.activo)
      .lastInsertRowid;
    emitir('productos');
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

app.put(
  '/api/productos/:id',
  rol('admin'),
  ruta((req) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM productos WHERE id = ?').get(id)) fail(404, 'Producto no encontrado');
    const p = validarProducto(req.body);
    db.prepare(
      `UPDATE productos SET nombre=?, descripcion=?, categoria=?, precio=?, tipo=?, fecha=?, para_local=?, para_llevar=?, disponible=?, activo=?
       WHERE id=?`
    ).run(p.nombre, p.descripcion, p.categoria, p.precio, p.tipo, p.fecha, p.para_local, p.para_llevar, p.disponible, p.activo, id);
    emitir('productos');
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

// Marcar agotado / disponible (admin y cocina)
app.post(
  '/api/productos/:id/disponible',
  rol('admin', 'cocina'),
  ruta((req) => {
    const id = Number(req.params.id);
    const r = db.prepare('UPDATE productos SET disponible = ? WHERE id = ?').run(bool(req.body.disponible), id);
    if (!r.changes) fail(404, 'Producto no encontrado');
    emitir('productos');
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
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

// Copia el menú de un día a otro (para armar rápido el menú diario)
app.post(
  '/api/productos/copiar-menu',
  rol('admin'),
  ruta((req) => {
    const { desde, hasta } = req.body;
    if (!esFecha(desde) || !esFecha(hasta) || desde === hasta) fail(400, 'Fechas inválidas');
    const origen = db.prepare("SELECT * FROM productos WHERE tipo = 'menu' AND fecha = ? AND activo = 1").all(desde);
    if (!origen.length) fail(404, 'No hay menú registrado en la fecha de origen');
    const ins = db.prepare(
      `INSERT INTO productos (nombre, descripcion, categoria, precio, tipo, fecha, para_local, para_llevar)
       VALUES (?,?,?,?, 'menu', ?, ?, ?)`
    );
    tx(() => origen.forEach((p) => ins.run(p.nombre, p.descripcion, p.categoria, p.precio, hasta, p.para_local, p.para_llevar)));
    emitir('productos');
    return { ok: true, copiados: origen.length };
  })
);

// ---------------- comandas ----------------
const SQL_COMANDA = `
  SELECT c.*, m.numero AS mesa_numero, u.nombre AS mozo_nombre, m.mozo_id AS mesa_mozo_id,
    (SELECT h.fecha FROM comanda_historial h WHERE h.comanda_id = c.id AND h.estado = 'enviado_cocina'
       ORDER BY h.id DESC LIMIT 1) AS enviado_en
  FROM comandas c
  LEFT JOIN mesas m ON m.id = c.mesa_id
  LEFT JOIN usuarios u ON u.id = c.mozo_id`;

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

function obtenerComanda(id, conHistorial = false) {
  const c = db.prepare(`${SQL_COMANDA} WHERE c.id = ?`).get(id);
  if (!c) return null;
  const [conItems] = adjuntarItems([c]);
  if (conHistorial) {
    conItems.historial = db
      .prepare(
        `SELECT h.estado, h.fecha, u.nombre AS usuario FROM comanda_historial h
         LEFT JOIN usuarios u ON u.id = h.usuario_id WHERE h.comanda_id = ? ORDER BY h.id`
      )
      .all(id);
  }
  return conItems;
}

function puedeVer(user, c) {
  if (user.rol === 'admin' || user.rol === 'caja') return true;
  if (user.rol === 'mozo') return c.mozo_id === user.id || c.mesa_mozo_id === user.id;
  if (user.rol === 'cocina') return c.estado !== 'generado';
  return false;
}

function comandaVisible(req) {
  const c = obtenerComanda(Number(req.params.id), true);
  if (!c || !puedeVer(req.user, c)) fail(404, 'Comanda no encontrada');
  return c;
}

app.get(
  '/api/comandas',
  ruta((req) => {
    const fecha = esFecha(req.query.fecha) ? req.query.fecha : hoy();
    const where = ['c.fecha = ?'];
    const params = [fecha];
    if (req.user.rol === 'mozo') {
      where.push('(c.mozo_id = ? OR m.mozo_id = ?)');
      params.push(req.user.id, req.user.id);
    }
    if (req.user.rol === 'cocina' || req.query.vista === 'cocina') {
      where.push("c.estado IN ('enviado_cocina','en_proceso','esperando_entrega')");
    } else if (req.query.vista === 'activas') {
      where.push("c.estado NOT IN ('entregado','cancelado')");
    } else if (req.query.vista === 'por_cobrar') {
      where.push("c.estado <> 'cancelado' AND c.pagada = 0");
    }
    const filas = db.prepare(`${SQL_COMANDA} WHERE ${where.join(' AND ')} ORDER BY c.id DESC`).all(...params);
    return adjuntarItems(filas);
  })
);

app.get('/api/comandas/:id', ruta((req) => comandaVisible(req)));

// Valida y arma los ítems a partir de la carta vigente
function prepararItems(itemsBody, tipo) {
  if (!Array.isArray(itemsBody) || !itemsBody.length) fail(400, 'Agregue al menos un plato');
  const getP = db.prepare('SELECT * FROM productos WHERE id = ?');
  return itemsBody.map((it) => {
    const p = getP.get(Number(it.producto_id));
    if (!p || !p.activo) fail(400, 'Uno de los platos ya no existe');
    if (tipo === 'local' && !p.para_local) fail(400, `"${p.nombre}" no está disponible para mesa`);
    if (tipo === 'llevar' && !p.para_llevar) fail(400, `"${p.nombre}" no está disponible para llevar`);
    const cantidad = Math.max(1, Math.min(99, parseInt(it.cantidad, 10) || 1));
    return { producto_id: p.id, nombre: p.nombre, tipo: p.tipo, precio: p.precio, cantidad, nota: texto(it.nota, 150), disponible: p.disponible, p };
  });
}

function validarCabecera(req, b) {
  const tipo = b.tipo === 'llevar' ? 'llevar' : 'local';
  let mesa_id = null;
  if (tipo === 'local') {
    mesa_id = Number(b.mesa_id);
    const mesa = db.prepare('SELECT * FROM mesas WHERE id = ? AND activa = 1').get(mesa_id);
    if (!mesa) fail(400, 'Seleccione una mesa válida');
  }
  return { tipo, mesa_id, cliente: texto(b.cliente, 80), nota: texto(b.nota, 300) };
}

function guardarItems(comandaId, items) {
  db.prepare('DELETE FROM comanda_items WHERE comanda_id = ?').run(comandaId);
  const ins = db.prepare(
    'INSERT INTO comanda_items (comanda_id, producto_id, nombre, tipo, precio, cantidad, nota) VALUES (?,?,?,?,?,?,?)'
  );
  let total = 0;
  for (const it of items) {
    ins.run(comandaId, it.producto_id, it.nombre, it.tipo, it.precio, it.cantidad, it.nota);
    total += it.precio * it.cantidad;
  }
  db.prepare('UPDATE comandas SET total = ?, actualizado_en = ? WHERE id = ?').run(Math.round(total * 100) / 100, ahora(), comandaId);
}

function registrarEstado(comandaId, estado, usuarioId) {
  db.prepare('UPDATE comandas SET estado = ?, actualizado_en = ? WHERE id = ?').run(estado, ahora(), comandaId);
  db.prepare('INSERT INTO comanda_historial (comanda_id, estado, usuario_id, fecha) VALUES (?,?,?,?)').run(comandaId, estado, usuarioId, ahora());
}

function notificarComanda(id, accion) {
  const c = db.prepare(`${SQL_COMANDA} WHERE c.id = ?`).get(id);
  emitir('comandas', c ? { accion, id, numero: c.numero_dia, estado: c.estado, mozo_id: c.mozo_id, mesa: c.mesa_numero, tipo: c.tipo } : { accion, id });
  emitir('mesas');
}

app.post(
  '/api/comandas',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const cab = validarCabecera(req, req.body);
    const items = prepararItems(req.body.items, cab.tipo);
    const agotado = items.find((i) => !i.disponible);
    if (agotado) fail(400, `"${agotado.nombre}" está agotado`);
    let mozoId = req.user.id;
    if (req.user.rol !== 'mozo' && cab.tipo === 'local') {
      // si la crea admin/caja, se asigna al mozo de la mesa (si tiene)
      const mesa = db.prepare('SELECT mozo_id FROM mesas WHERE id = ?').get(cab.mesa_id);
      if (mesa?.mozo_id) mozoId = mesa.mozo_id;
    }
    const id = tx(() => {
      const fecha = hoy();
      const { sig } = db.prepare('SELECT COALESCE(MAX(numero_dia),0)+1 AS sig FROM comandas WHERE fecha = ?').get(fecha);
      const nuevoId = db
        .prepare(
          `INSERT INTO comandas (numero_dia, fecha, tipo, mesa_id, mozo_id, cliente, nota, estado, creado_en, actualizado_en)
           VALUES (?,?,?,?,?,?,?, 'generado', ?, ?)`
        )
        .run(sig, fecha, cab.tipo, cab.mesa_id, mozoId, cab.cliente, cab.nota, ahora(), ahora()).lastInsertRowid;
      db.prepare('INSERT INTO comanda_historial (comanda_id, estado, usuario_id, fecha) VALUES (?,?,?,?)').run(nuevoId, 'generado', req.user.id, ahora());
      guardarItems(nuevoId, items);
      if (req.body.enviar) registrarEstado(nuevoId, 'enviado_cocina', req.user.id);
      return nuevoId;
    });
    notificarComanda(id, 'creada');
    return obtenerComanda(id, true);
  })
);

app.put(
  '/api/comandas/:id',
  rol('admin', 'mozo', 'caja'),
  ruta((req) => {
    const c = comandaVisible(req);
    const editable = c.estado === 'generado' || (req.user.rol === 'admin' && !['entregado', 'cancelado'].includes(c.estado));
    if (!editable) fail(400, 'Solo se pueden editar comandas que aún no se enviaron a cocina');
    const cab = validarCabecera(req, req.body);
    const items = prepararItems(req.body.items, cab.tipo);
    tx(() => {
      db.prepare('UPDATE comandas SET tipo=?, mesa_id=?, cliente=?, nota=?, actualizado_en=? WHERE id=?').run(
        cab.tipo, cab.mesa_id, cab.cliente, cab.nota, ahora(), c.id
      );
      guardarItems(c.id, items);
      if (req.body.enviar && c.estado === 'generado') registrarEstado(c.id, 'enviado_cocina', req.user.id);
    });
    notificarComanda(c.id, 'editada');
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
    if (req.user.rol !== 'admin' && !(permitidos && permitidos.includes(req.user.rol))) {
      fail(403, `No puede pasar la comanda de "${c.estado}" a "${nuevo}"`);
    }
    tx(() => registrarEstado(c.id, nuevo, req.user.id));
    notificarComanda(c.id, 'estado');
    return obtenerComanda(c.id, true);
  })
);

app.post(
  '/api/comandas/:id/pago',
  rol('admin', 'caja'),
  ruta((req) => {
    const c = comandaVisible(req);
    if (c.estado === 'cancelado') fail(400, 'La comanda está cancelada');
    db.prepare('UPDATE comandas SET pagada = ?, actualizado_en = ? WHERE id = ?').run(bool(req.body.pagada), ahora(), c.id);
    notificarComanda(c.id, 'pago');
    return obtenerComanda(c.id, true);
  })
);

app.delete(
  '/api/comandas/:id',
  rol('admin'),
  ruta((req) => {
    const c = comandaVisible(req);
    db.prepare('DELETE FROM comandas WHERE id = ?').run(c.id);
    notificarComanda(c.id, 'eliminada');
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
          SUM(CASE WHEN c.tipo = 'local' THEN 1 ELSE 0 END) AS en_mesa,
          SUM(CASE WHEN c.tipo = 'llevar' THEN 1 ELSE 0 END) AS para_llevar
         FROM comandas c WHERE ${validas}`
      )
      .get(fecha);
    resumen.canceladas = db.prepare("SELECT COUNT(*) AS n FROM comandas WHERE fecha = ? AND estado = 'cancelado'").get(fecha).n;
    resumen.ticket_promedio = resumen.comandas ? resumen.total_vendido / resumen.comandas : 0;

    const porEstado = db.prepare('SELECT estado, COUNT(*) AS cantidad FROM comandas WHERE fecha = ? GROUP BY estado').all(fecha);

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

    const empleados = db
      .prepare(
        `SELECT u.nombre, u.rol, MIN(t.inicio) AS inicio,
           CASE WHEN SUM(t.fin IS NULL) > 0 THEN NULL ELSE MAX(t.fin) END AS fin
         FROM turnos t JOIN usuarios u ON u.id = t.usuario_id
         WHERE t.fecha = ? GROUP BY t.usuario_id ORDER BY u.rol, u.nombre`
      )
      .all(fecha);

    // Tiempo promedio en cocina (enviado -> listo), en minutos
    const tiempos = db
      .prepare(
        `SELECT AVG((julianday(l.fecha) - julianday(e.fecha)) * 1440) AS prom_cocina
         FROM comandas c
         JOIN (SELECT comanda_id, MIN(fecha) AS fecha FROM comanda_historial WHERE estado = 'enviado_cocina' GROUP BY comanda_id) e ON e.comanda_id = c.id
         JOIN (SELECT comanda_id, MAX(fecha) AS fecha FROM comanda_historial WHERE estado = 'esperando_entrega' GROUP BY comanda_id) l ON l.comanda_id = c.id
         WHERE ${validas}`
      )
      .get(fecha);

    return {
      fecha,
      resumen: { ...resumen, empleados_en_turno: empleados.length, tiempo_promedio_cocina: tiempos.prom_cocina },
      porEstado,
      porMozo,
      mesas,
      productos,
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
  for (const lista of Object.values(os.networkInterfaces())) {
    for (const i of lista || []) {
      if (i.family === 'IPv4' && !i.internal) console.log(`Desde celulares: http://${i.address}:${PUERTO}`);
    }
  }
  console.log('');
});
