// Base de datos SQLite local (archivo data/comandas.db)
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'comandas.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','mozo','caja','cocina')),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  inicio TEXT NOT NULL,
  fin TEXT
);

CREATE TABLE IF NOT EXISTS mesas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  capacidad INTEGER NOT NULL DEFAULT 4,
  mozo_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  activa INTEGER NOT NULL DEFAULT 1
);

-- tipo: 'menu' (menú del día, ligado a una fecha) o 'extra' (carta permanente)
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  precio REAL NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('menu','extra')),
  fecha TEXT,
  para_local INTEGER NOT NULL DEFAULT 1,
  para_llevar INTEGER NOT NULL DEFAULT 1,
  disponible INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS comandas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_dia INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('local','llevar')),
  mesa_id INTEGER REFERENCES mesas(id) ON DELETE SET NULL,
  mozo_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  cliente TEXT NOT NULL DEFAULT '',
  nota TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'generado'
    CHECK (estado IN ('generado','enviado_cocina','en_proceso','esperando_entrega','entregado','cancelado')),
  total REAL NOT NULL DEFAULT 0,
  pagada INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL,
  actualizado_en TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comanda_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'extra',
  precio REAL NOT NULL,
  cantidad INTEGER NOT NULL DEFAULT 1,
  nota TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS comanda_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  estado TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comandas_fecha ON comandas(fecha);
CREATE INDEX IF NOT EXISTS idx_comandas_estado ON comandas(estado);
CREATE INDEX IF NOT EXISTS idx_productos_tipo_fecha ON productos(tipo, fecha);
CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(fecha);
`);

// ---------- utilidades ----------
const z = (n) => String(n).padStart(2, '0');
function hoy(d = new Date()) {
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
function ahora(d = new Date()) {
  return `${hoy(d)} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verificarPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 64);
  const buf = Buffer.from(hash, 'hex');
  return buf.length === calc.length && crypto.timingSafeEqual(buf, calc);
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- datos iniciales (solo si la base está vacía) ----------
function sembrar() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  if (n > 0) return false;
  tx(() => {
    const insU = db.prepare(
      'INSERT INTO usuarios (nombre, usuario, password_hash, rol, creado_en) VALUES (?,?,?,?,?)'
    );
    insU.run('Administrador', 'admin', hashPassword('admin123'), 'admin', ahora());
    const mozo1 = insU.run('Mozo Uno', 'mozo1', hashPassword('1234'), 'mozo', ahora()).lastInsertRowid;
    const mozo2 = insU.run('Mozo Dos', 'mozo2', hashPassword('1234'), 'mozo', ahora()).lastInsertRowid;
    insU.run('Caja', 'caja1', hashPassword('1234'), 'caja', ahora());
    insU.run('Cocina', 'cocina1', hashPassword('1234'), 'cocina', ahora());

    const insM = db.prepare('INSERT INTO mesas (numero, capacidad, mozo_id) VALUES (?,?,?)');
    for (let i = 1; i <= 8; i++) insM.run(String(i), i % 3 === 0 ? 6 : 4, i <= 4 ? mozo1 : mozo2);

    const insP = db.prepare(
      'INSERT INTO productos (nombre, descripcion, categoria, precio, tipo, fecha, para_local, para_llevar) VALUES (?,?,?,?,?,?,?,?)'
    );
    const f = hoy();
    insP.run('Menú: Sopa de casa + Ají de gallina', 'Incluye refresco', 'Menú', 15, 'menu', f, 1, 1);
    insP.run('Menú: Crema de zapallo + Lomo saltado', 'Incluye refresco', 'Menú', 16, 'menu', f, 1, 1);
    insP.run('Menú: Ensalada + Arroz con pollo', 'Incluye refresco', 'Menú', 14, 'menu', f, 1, 0);
    insP.run('Ceviche clásico', '', 'Fondos', 28, 'extra', null, 1, 1);
    insP.run('Lomo saltado', '', 'Fondos', 30, 'extra', null, 1, 1);
    insP.run('Chicharrón de pescado', '', 'Fondos', 26, 'extra', null, 1, 1);
    insP.run('Porción de papas fritas', '', 'Adicionales', 8, 'extra', null, 1, 1);
    insP.run('Gaseosa 500 ml', '', 'Bebidas', 5, 'extra', null, 1, 1);
    insP.run('Jarra de chicha morada', '', 'Bebidas', 12, 'extra', null, 1, 0);
  });
  return true;
}

// ---------- respaldo diario ----------
function respaldar(diasRetencion = 30) {
  const dir = path.join(DATA_DIR, 'respaldos');
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `comandas-${hoy()}.db`);
  if (!fs.existsSync(destino)) {
    db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  }
  const archivos = fs.readdirSync(dir).filter((f) => /^comandas-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  while (archivos.length > diasRetencion) fs.unlinkSync(path.join(dir, archivos.shift()));
  return destino;
}

module.exports = { db, tx, hoy, ahora, hashPassword, verificarPassword, sembrar, respaldar, DB_PATH };
