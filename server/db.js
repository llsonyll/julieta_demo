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

-- Guarniciones (arroz, papas, picante de lisas, kapchi...)
CREATE TABLE IF NOT EXISTS guarniciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Catálogo de platos. tipo: 'menu' (sale solo los días que se elige en menu_dia)
-- o 'extra' (carta fija). Ambos pueden llevar guarnición por defecto + guarnición a elección.
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  precio REAL NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('menu','extra')),
  fecha TEXT,
  guarnicion_base_id INTEGER REFERENCES guarniciones(id) ON DELETE SET NULL,
  con_eleccion INTEGER NOT NULL DEFAULT 0,
  para_local INTEGER NOT NULL DEFAULT 1,
  para_llevar INTEGER NOT NULL DEFAULT 1,
  disponible INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1
);

-- Qué platos de tipo 'menu' salen cada día
CREATE TABLE IF NOT EXISTS menu_dia (
  fecha TEXT NOT NULL,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  PRIMARY KEY (fecha, producto_id)
);

-- Qué guarniciones se ofrecen "a elección" cada día
CREATE TABLE IF NOT EXISTS guarniciones_dia (
  fecha TEXT NOT NULL,
  guarnicion_id INTEGER NOT NULL REFERENCES guarniciones(id) ON DELETE CASCADE,
  PRIMARY KEY (fecha, guarnicion_id)
);

CREATE TABLE IF NOT EXISTS cobros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL,
  total REAL NOT NULL,
  metodo TEXT NOT NULL,
  recibido REAL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  anulado INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL
);

-- estado 'enviado_cocina' se muestra como "En cocina".
-- 'en_proceso' y 'esperando_entrega' quedan solo por compatibilidad con datos antiguos.
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
  cobro_id INTEGER REFERENCES cobros(id) ON DELETE SET NULL,
  ticket_impreso INTEGER NOT NULL DEFAULT 0,
  ticket_modificado INTEGER NOT NULL DEFAULT 0,
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
  nota TEXT NOT NULL DEFAULT '',
  guarnicion_base_id INTEGER,
  guarnicion_base TEXT NOT NULL DEFAULT '',
  guarnicion_defecto TEXT NOT NULL DEFAULT '',
  guarnicion_eleccion_id INTEGER,
  guarnicion_eleccion TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS comanda_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comanda_id INTEGER NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  estado TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  fecha TEXT NOT NULL
);
`);

// ---------- migración de bases creadas con la versión anterior ----------
function agregarColumna(tabla, columna, definicion) {
  const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
  if (!existe) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
agregarColumna('productos', 'guarnicion_base_id', 'INTEGER REFERENCES guarniciones(id) ON DELETE SET NULL');
agregarColumna('productos', 'con_eleccion', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('comandas', 'cobro_id', 'INTEGER REFERENCES cobros(id) ON DELETE SET NULL');
agregarColumna('comandas', 'ticket_impreso', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('comandas', 'ticket_modificado', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('comanda_items', 'guarnicion_base_id', 'INTEGER');
agregarColumna('comanda_items', 'guarnicion_base', "TEXT NOT NULL DEFAULT ''");
agregarColumna('comanda_items', 'guarnicion_defecto', "TEXT NOT NULL DEFAULT ''");
agregarColumna('comanda_items', 'guarnicion_eleccion_id', 'INTEGER');
agregarColumna('comanda_items', 'guarnicion_eleccion', "TEXT NOT NULL DEFAULT ''");
// El menú antes se guardaba con su fecha en productos: se pasa a menu_dia
db.exec(`INSERT OR IGNORE INTO menu_dia (fecha, producto_id)
         SELECT fecha, id FROM productos WHERE tipo = 'menu' AND fecha IS NOT NULL`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_comandas_fecha ON comandas(fecha);
CREATE INDEX IF NOT EXISTS idx_comandas_estado ON comandas(estado);
CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(fecha);
CREATE INDEX IF NOT EXISTS idx_cobros_fecha ON cobros(fecha);
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
    const mozos = ['Mozo Uno', 'Mozo Dos', 'Mozo Tres'].map(
      (nombre, i) => insU.run(nombre, `mozo${i + 1}`, hashPassword('1234'), 'mozo', ahora()).lastInsertRowid
    );
    insU.run('Caja', 'caja1', hashPassword('1234'), 'caja', ahora());
    insU.run('Cocina', 'cocina1', hashPassword('1234'), 'cocina', ahora());

    const insM = db.prepare('INSERT INTO mesas (numero, capacidad, mozo_id) VALUES (?,?,?)');
    for (let i = 1; i <= 9; i++) insM.run(String(i), i % 3 === 0 ? 6 : 4, mozos[Math.floor((i - 1) / 3)]);

    const insG = db.prepare('INSERT INTO guarniciones (nombre) VALUES (?)');
    const g = {};
    for (const nombre of ['Arroz', 'Papas fritas', 'Yuca frita', 'Ensalada fresca', 'Picante de lisas', 'Kapchi', 'Solterito']) {
      g[nombre] = insG.run(nombre).lastInsertRowid;
    }

    const insP = db.prepare(
      `INSERT INTO productos (nombre, descripcion, categoria, precio, tipo, guarnicion_base_id, con_eleccion, para_local, para_llevar)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    const f = hoy();
    const menu = [
      insP.run('Malaya frita', '', 'Menú', 16, 'menu', g['Arroz'], 1, 1, 1).lastInsertRowid,
      insP.run('Pollo al horno', '', 'Menú', 14, 'menu', g['Arroz'], 1, 1, 1).lastInsertRowid,
      insP.run('Estofado de res', '', 'Menú', 15, 'menu', g['Arroz'], 1, 1, 1).lastInsertRowid,
    ];
    insP.run('Chicharrón de chancho', '', 'Menú', 17, 'menu', g['Papas fritas'], 1, 1, 1);
    insP.run('Lomo saltado', '', 'Fondos', 28, 'extra', g['Arroz'], 1, 1, 1);
    insP.run('Chuleta frita', '', 'Fondos', 24, 'extra', g['Arroz'], 1, 1, 1);
    insP.run('Rocoto relleno', '', 'Fondos', 22, 'extra', g['Papas fritas'], 0, 1, 1);
    insP.run('Gaseosa 500 ml', '', 'Bebidas', 5, 'extra', null, 0, 1, 1);
    insP.run('Chicha morada (jarra)', '', 'Bebidas', 12, 'extra', null, 0, 1, 0);

    const insMD = db.prepare('INSERT INTO menu_dia (fecha, producto_id) VALUES (?,?)');
    for (const id of menu) insMD.run(f, id);
    const insGD = db.prepare('INSERT INTO guarniciones_dia (fecha, guarnicion_id) VALUES (?,?)');
    for (const nombre of ['Picante de lisas', 'Kapchi', 'Solterito']) insGD.run(f, g[nombre]);
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
