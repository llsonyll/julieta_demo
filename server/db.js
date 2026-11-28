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
  activa INTEGER NOT NULL DEFAULT 1
);

-- Guarniciones (arroz, papas, picante de lisas, kapchi...)
CREATE TABLE IF NOT EXISTS guarniciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  -- se ofrece como guarnición a elección cuando el día no define otras
  eleccion_habitual INTEGER NOT NULL DEFAULT 0
);

-- Catálogo de platos. tipo: 'menu' o 'extra' (carta fija, precio propio).
-- Menú (precio fijo, ajustes.precio_menu): menu_rol 'sopa' / 'refresco' (uno por día, en menu_dia),
-- 'fijo' (segundo que sale todos los días) o 'variable' (segundo elegido en menu_dia). Ambos pueden llevar guarnición por defecto + guarnición a elección.
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  precio REAL NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL CHECK (tipo IN ('menu','extra','bebidas')),
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

db.exec(`
CREATE TABLE IF NOT EXISTS usuario_roles (
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  rol TEXT NOT NULL CHECK(rol IN ('admin','mozo','caja','cocina')),
  PRIMARY KEY (usuario_id, rol)
);
CREATE INDEX IF NOT EXISTS idx_usuario_roles ON usuario_roles(usuario_id);
`);

// ---------- migración de bases creadas con la versión anterior ----------
function agregarColumna(tabla, columna, definicion) {
  const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
  if (!existe) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}
agregarColumna('guarniciones', 'eleccion_habitual', 'INTEGER NOT NULL DEFAULT 0');
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
agregarColumna('usuarios', 'pin_hash', 'TEXT');
agregarColumna('productos', 'menu_rol', "TEXT NOT NULL DEFAULT 'variable'");
agregarColumna('comanda_items', 'sopa', "TEXT NOT NULL DEFAULT ''");
agregarColumna('comanda_items', 'refresco', "TEXT NOT NULL DEFAULT ''");
agregarColumna('mesas', 'piso', "TEXT NOT NULL DEFAULT 'Nivel 1'");
agregarColumna('mesas', 'zona', "TEXT NOT NULL DEFAULT 'Salón'");
agregarColumna('mesas', 'forma', "TEXT NOT NULL DEFAULT 'rectangular'");
// Plano: posición y tamaño en unidades donde el ancho del nivel mide 100
agregarColumna('mesas', 'x', 'REAL NOT NULL DEFAULT 2');
agregarColumna('mesas', 'y', 'REAL NOT NULL DEFAULT 2');
agregarColumna('mesas', 'ancho', 'REAL NOT NULL DEFAULT 20');
agregarColumna('mesas', 'alto', 'REAL NOT NULL DEFAULT 15');
// Unión temporal: las mesas unidas apuntan a la principal (la de menor número)
agregarColumna('mesas', 'unida_a', 'INTEGER');
// Número de mesa con el que se tomó la comanda ("10-11" si estaban unidas)
agregarColumna('comandas', 'mesa_etiqueta', "TEXT NOT NULL DEFAULT ''");
// Migración: agregar tipo 'bebidas' al CHECK constraint de productos
{
  const _sq = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='productos'").get();
  if (_sq && !_sq.sql.includes("'bebidas'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`
      CREATE TABLE productos_migr (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        descripcion TEXT NOT NULL DEFAULT '',
        categoria TEXT NOT NULL DEFAULT '',
        precio REAL NOT NULL DEFAULT 0,
        tipo TEXT NOT NULL CHECK (tipo IN ('menu','extra','bebidas')),
        fecha TEXT,
        menu_rol TEXT NOT NULL DEFAULT 'variable',
        guarnicion_base_id INTEGER REFERENCES guarniciones(id) ON DELETE SET NULL,
        con_eleccion INTEGER NOT NULL DEFAULT 0,
        para_local INTEGER NOT NULL DEFAULT 1,
        para_llevar INTEGER NOT NULL DEFAULT 1,
        disponible INTEGER NOT NULL DEFAULT 1,
        activo INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO productos_migr (id, nombre, descripcion, categoria, precio, tipo, fecha, menu_rol, guarnicion_base_id, con_eleccion, para_local, para_llevar, disponible, activo)
        SELECT id, nombre, descripcion, categoria, precio, tipo, fecha, COALESCE(menu_rol, 'variable'), guarnicion_base_id, con_eleccion, para_local, para_llevar, disponible, activo FROM productos;
      DROP TABLE productos;
      ALTER TABLE productos_migr RENAME TO productos;
    `);
    db.exec('PRAGMA foreign_keys = ON');
  }
}
db.exec(`CREATE TABLE IF NOT EXISTS plano_elementos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  piso TEXT NOT NULL,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'muro',
  x REAL NOT NULL, y REAL NOT NULL, ancho REAL NOT NULL, alto REAL NOT NULL
)`);

// Plano inicial tomado del croquis del local: [numero, nivel, x, y, ancho, alto]
const PLANO_MESAS = [
  ['1', 'Nivel 1', 45.5, 40, 26.7, 16.7], ['2', 'Nivel 1', 6.8, 38, 26.7, 16.7],
  ['3', 'Nivel 1', 46, 8.2, 26.7, 16.7], ['4', 'Nivel 1', 6.7, 8.8, 26.7, 16.7],
  ['5', 'Nivel 2', 71.7, 17.3, 19.5, 15.3], ['6', 'Nivel 2', 72.3, 1.7, 19.5, 15.3],
  ['7', 'Nivel 2', 23.7, 6, 19.5, 15.3], ['8', 'Nivel 2', 3.7, 5.8, 19.5, 15.3],
  ['9', 'Nivel 2', 2.2, 31.5, 19.5, 15.3], ['10', 'Nivel 2', 2.3, 56.8, 19.5, 15.3],
  ['11', 'Nivel 2', 2, 82.2, 19.5, 15.3], ['12', 'Nivel 2', 2.5, 108.7, 19.5, 15.3],
  ['13', 'Nivel 2', 37.2, 113.5, 19.5, 15.3], ['14', 'Nivel 2', 75.5, 108.8, 19.5, 15.3],
  ['15', 'Nivel 2', 75.3, 80.5, 19.5, 15.3],
];
// [nivel, nombre, tipo, x, y, ancho, alto]; tipo: escalera | servicio | puerta | ventana
const PLANO_ELEMENTOS = [
  ['Nivel 1', 'Escaleras', 'escalera', 76.7, 7.7, 21.3, 39.7],
  ['Nivel 1', 'Puerta', 'puerta', 95.2, 48.7, 3, 18],
  ['Nivel 1', 'SSHH', 'servicio', 2.7, 92, 26.2, 10],
  ['Nivel 1', 'Puerta cocina', 'puerta', 31.3, 99, 21.7, 2.7],
  ['Nivel 1', 'Caja', 'servicio', 55.8, 83.2, 40.8, 19.3],
  ['Nivel 2', 'Escaleras', 'escalera', 72.2, 36.5, 22, 37.3],
  ['Nivel 2', 'Ventana', 'ventana', 98.3, 9.3, 1.5, 21.7],
  ['Nivel 2', 'Ventana', 'ventana', 98.3, 77.7, 1.5, 21.3],
];
function aplicarPlanoInicial() {
  const ins = db.prepare("INSERT OR IGNORE INTO mesas (numero, capacidad, piso, zona, forma) VALUES (?, 4, ?, 'Salón', 'rectangular')");
  const pos = db.prepare('UPDATE mesas SET piso=?, x=?, y=?, ancho=?, alto=? WHERE numero=?');
  for (const [numero, piso, x, y, ancho, alto] of PLANO_MESAS) {
    ins.run(numero, piso);
    pos.run(piso, x, y, ancho, alto, numero);
  }
  const insE = db.prepare('INSERT INTO plano_elementos (piso, nombre, tipo, x, y, ancho, alto) VALUES (?,?,?,?,?,?,?)');
  for (const e of PLANO_ELEMENTOS) insE.run(...e);
}
// Bases anteriores: se ubican las mesas según el croquis (y se crean las que falten) una sola vez
if (!db.prepare('SELECT 1 FROM plano_elementos').get() && db.prepare('SELECT 1 FROM mesas').get()) aplicarPlanoInicial();
// El menú antes se guardaba con su fecha en productos: se pasa a menu_dia
db.exec(`INSERT OR IGNORE INTO menu_dia (fecha, producto_id)
         SELECT fecha, id FROM productos WHERE tipo = 'menu' AND fecha IS NOT NULL`);

db.exec(`
CREATE INDEX IF NOT EXISTS idx_comandas_fecha ON comandas(fecha);
CREATE INDEX IF NOT EXISTS idx_comandas_estado ON comandas(estado);
CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(fecha);
CREATE INDEX IF NOT EXISTS idx_cobros_fecha ON cobros(fecha);
`);

// Migración: poblar usuario_roles desde usuarios.rol (bases anteriores a esta versión)
db.exec(`INSERT OR IGNORE INTO usuario_roles (usuario_id, rol) SELECT id, rol FROM usuarios`);

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

// ---------- atenciones: la visita de un cliente (o grupo) a una mesa; agrupa sus comandas ----------
// Abierta mientras tenga comandas pendientes de cobro. Una mesa puede tener varias atenciones abiertas (mesa compartida).
db.exec(`
CREATE TABLE IF NOT EXISTS atenciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero_dia INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('local','llevar')),
  mesa_id INTEGER REFERENCES mesas(id) ON DELETE SET NULL,
  cliente TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta','cerrada')),
  creado_en TEXT NOT NULL,
  cerrado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_atenciones_mesa ON atenciones(fecha, estado, mesa_id);
`);
agregarColumna('comandas', 'atencion_id', 'INTEGER REFERENCES atenciones(id) ON DELETE SET NULL');
db.exec('CREATE INDEX IF NOT EXISTS idx_comandas_atencion ON comandas(atencion_id)');

// Comandas anteriores: las cobradas juntas forman una atención; las pendientes de una mesa, otra; el resto, una cada una
{
  const sueltas = db.prepare('SELECT * FROM comandas WHERE atencion_id IS NULL ORDER BY id').all();
  if (sueltas.length)
    tx(() => {
      const grupos = new Map();
      for (const c of sueltas) {
        const pendiente = !c.pagada && c.estado !== 'cancelado';
        const clave = c.cobro_id ? `cobro-${c.cobro_id}` : pendiente && c.tipo === 'local' ? `mesa-${c.fecha}-${c.mesa_id}` : `comanda-${c.id}`;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(c);
      }
      const sig = db.prepare('SELECT COALESCE(MAX(numero_dia),0)+1 AS n FROM atenciones WHERE fecha = ?');
      const ins = db.prepare(
        'INSERT INTO atenciones (numero_dia, fecha, tipo, mesa_id, cliente, estado, creado_en, cerrado_en) VALUES (?,?,?,?,?,?,?,?)'
      );
      const upd = db.prepare('UPDATE comandas SET atencion_id = ? WHERE id = ?');
      for (const cs of grupos.values()) {
        const [c] = cs;
        const abierta = cs.some((x) => !x.pagada && x.estado !== 'cancelado');
        const id = ins.run(sig.get(c.fecha).n, c.fecha, c.tipo, c.mesa_id, c.cliente, abierta ? 'abierta' : 'cerrada', c.creado_en,
          abierta ? null : cs.at(-1).actualizado_en).lastInsertRowid;
        cs.forEach((x) => upd.run(id, x.id));
      }
    });
}

// ---------- ingreso con PIN ----------
// password_hash queda sin uso (antes se ingresaba con contraseña).
const PIN_INICIAL = '1234';
const esPin = (v) => /^\d{4}$/.test(String(v ?? ''));
// Usuarios de una base anterior (sin PIN) reciben el PIN inicial: el admin debe cambiarlo.
const sinPin = db.prepare('SELECT id, usuario FROM usuarios WHERE pin_hash IS NULL').all();
for (const u of sinPin) db.prepare('UPDATE usuarios SET pin_hash = ? WHERE id = ?').run(hashPassword(PIN_INICIAL), u.id);
if (sinPin.length)
  console.warn(`Usuarios sin PIN (${sinPin.map((u) => u.usuario).join(', ')}): se les asignó el PIN ${PIN_INICIAL}. Cámbielo en Gestión → Usuarios.`);

// ---------- datos iniciales (solo si la base está vacía) ----------
function sembrar() {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM usuarios').get();
  if (n > 0) return false;
  tx(() => {
    const insU = db.prepare(
      "INSERT INTO usuarios (nombre, usuario, pin_hash, rol, creado_en, password_hash) VALUES (?,?,?,?,?,'')"
    );
    const insUR = db.prepare('INSERT OR IGNORE INTO usuario_roles (usuario_id, rol) VALUES (?,?)');
    const ins = (nombre, usuario, rol) => {
      const id = insU.run(nombre, usuario, hashPassword(PIN_INICIAL), rol, ahora()).lastInsertRowid;
      insUR.run(id, rol);
      return id;
    };
    ins('Administrador', 'admin', 'admin');
    const mozos = ['Mozo Uno', 'Mozo Dos', 'Mozo Tres'].map((nombre, i) => ins(nombre, `mozo${i + 1}`, 'mozo'));
    ins('Caja', 'caja1', 'caja');
    ins('Cocina', 'cocina1', 'cocina');

    aplicarPlanoInicial();

    // Los platos y guarniciones se cargan desde carta/platos-tradicionales.json (ver server/carta-inicial.js)
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

module.exports = { db, tx, hoy, ahora, hashPassword, verificarPassword, esPin, sembrar, respaldar, DB_PATH };
