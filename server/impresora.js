// Impresoras térmicas: varias impresoras, qué imprime cada una, colas con reintentos y envío.
//
// Cada impresora tiene su conexión (ajuste "modo"):
//   com      Bluetooth o USB que Windows expone como puerto COM (ej: COM5). Se escribe directo.
//   windows  Impresora instalada en Windows con su controlador (USB, Bluetooth o red). Se envía en RAW.
//   red      Impresora con IP propia (puerto 9100).
//   archivo  Solo para pruebas: guarda cada ticket en data/impresiones/*.bin
//
// Las asignaciones dicen a qué impresora va cada documento (comandas, precuentas, comprobantes).
// Sin impresora asignada, ese documento se imprime en PDF desde el navegador, como antes.
//
// Cada trabajo se guarda en la tabla cola_impresion antes de enviarse. Cada impresora tiene su
// propia cola: si una no responde, sus tickets esperan y se reintentan solos, y las demás siguen.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { db, ahora } = require('./db');

const DIR = path.join(__dirname, '..', 'data', 'impresora');
const DIR_ARCHIVOS = path.join(__dirname, '..', 'data', 'impresiones');
const MAX_IMPRESORAS = 4;
const DOCUMENTOS = ['comanda', 'precuenta', 'comprobante'];

db.exec(`
CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cola_impresion (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,              -- comanda | precuenta | comprobante | prueba
  ref INTEGER,                     -- id de la comanda o del cobro
  titulo TEXT NOT NULL,
  datos BLOB NOT NULL,             -- bytes ESC/POS listos para enviar
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | error | impreso | cancelado
  intentos INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  creado_en TEXT NOT NULL,
  impreso_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_cola_estado ON cola_impresion(estado);
`);
if (!db.prepare('PRAGMA table_info(cola_impresion)').all().some((c) => c.name === 'impresora_id'))
  db.exec('ALTER TABLE cola_impresion ADD COLUMN impresora_id INTEGER');
// lo ya impreso o cancelado hace más de 7 días se borra
db.prepare("DELETE FROM cola_impresion WHERE estado IN ('impreso','cancelado') AND creado_en < datetime('now','localtime','-7 days')").run();

// ---------------- ajustes guardados ----------------
function leer(clave) {
  const fila = db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave);
  try {
    return fila ? JSON.parse(fila.valor) : null;
  } catch {
    return null;
  }
}
function escribir(clave, valor) {
  db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, JSON.stringify(valor));
}

const IMPRESORA_BASE = {
  nombre: 'Ticketera',
  modo: 'com',
  puerto: '', // COM5
  baudios: 9600,
  nombreWindows: '', // nombre de la impresora en Windows
  host: '', // IP en modo red
  puertoRed: 9100,
  columnas: 48, // 80 mm = 48 (algunos modelos 42); 58 mm = 32
  pagina: 'cp850', // página de códigos para los acentos: cp850 o wpc1252
  cortar: true,
  logo: true,
};
const ASIGNACIONES_BASE = { comanda: null, precuenta: null, comprobante: null, autoComandas: true, copiasComanda: 1 };
const MODOS = ['com', 'windows', 'red', 'archivo'];

// Migración: la versión anterior tenía una sola ticketera (clave 'impresora')
if (!leer('impresoras')) {
  const viejo = leer('impresora');
  if (viejo && viejo.modo && viejo.modo !== 'ninguna') {
    const { modo, puerto, baudios, nombre, host, puertoRed, columnas, pagina, cortar, logo } = viejo;
    escribir('impresoras', [{ ...IMPRESORA_BASE, id: 1, nombre: 'Ticketera', modo, puerto, baudios, nombreWindows: nombre || '', host, puertoRed, columnas, pagina, cortar, logo }]);
    escribir('asignaciones', {
      ...ASIGNACIONES_BASE,
      comanda: 1,
      precuenta: viejo.caja !== false ? 1 : null,
      comprobante: viejo.caja !== false ? 1 : null,
      autoComandas: viejo.autoComandas !== false,
      copiasComanda: viejo.copiasComanda || 1,
    });
    db.prepare('UPDATE cola_impresion SET impresora_id = 1 WHERE impresora_id IS NULL').run();
  } else {
    escribir('impresoras', []);
    escribir('asignaciones', { ...ASIGNACIONES_BASE });
  }
}

const impresoras = () => (leer('impresoras') || []).map((i) => ({ ...IMPRESORA_BASE, ...i }));
const impresora = (id) => impresoras().find((i) => i.id === Number(id)) || null;
const asignaciones = () => ({ ...ASIGNACIONES_BASE, ...(leer('asignaciones') || {}) });
/** Impresora que imprime un documento (comanda, precuenta o comprobante), o null si va en PDF */
const destino = (doc) => impresora(asignaciones()[doc]);
/** Opciones de papel para convertir un documento a ESC/POS en esa impresora */
const opciones = (imp) => ({ columnas: imp.columnas, pagina: imp.pagina, cortar: imp.cortar, logo: imp.logo });

const si = (v) => v === true || v === 1 || v === '1' || v === 'true';
const txt = (v, max = 120) => String(v ?? '').trim().slice(0, max);

function validarImpresora(b, actual = IMPRESORA_BASE) {
  const a = { ...actual };
  if (b.nombre !== undefined) a.nombre = txt(b.nombre, 30);
  if (!a.nombre) throw new Error('Póngale un nombre a la impresora (ej: Cocina, Caja)');
  if (b.modo !== undefined) {
    if (!MODOS.includes(b.modo)) throw new Error('Forma de conexión inválida');
    a.modo = b.modo;
  }
  if (b.puerto !== undefined) a.puerto = txt(b.puerto, 20).toUpperCase();
  if (b.baudios !== undefined) a.baudios = parseInt(b.baudios, 10) || 9600;
  if (b.nombreWindows !== undefined) a.nombreWindows = txt(b.nombreWindows);
  if (b.host !== undefined) a.host = txt(b.host, 60);
  if (b.puertoRed !== undefined) a.puertoRed = parseInt(b.puertoRed, 10) || 9100;
  if (b.columnas !== undefined) a.columnas = [32, 42, 48].includes(Number(b.columnas)) ? Number(b.columnas) : 48;
  if (b.pagina !== undefined) a.pagina = b.pagina === 'wpc1252' ? 'wpc1252' : 'cp850';
  for (const k of ['cortar', 'logo']) if (b[k] !== undefined) a[k] = si(b[k]);

  if (a.modo === 'com' && !/^COM\d{1,3}$/.test(a.puerto)) throw new Error('Indique el puerto COM de la impresora (ej: COM5)');
  if (a.modo === 'windows' && !a.nombreWindows) throw new Error('Indique el nombre de la impresora en Windows');
  if (a.modo === 'red' && !/^[a-zA-Z0-9.-]+$/.test(a.host)) throw new Error('Indique la IP de la impresora (ej: 192.168.1.50)');
  if (['com', 'windows'].includes(a.modo) && process.platform !== 'win32')
    throw new Error('Esa forma de conexión solo funciona con el servidor en Windows');
  return a;
}

function comprobarDuplicados(lista, imp) {
  for (const o of lista) {
    if (o.id === imp.id) continue;
    if (o.nombre.toLowerCase() === imp.nombre.toLowerCase()) throw new Error(`Ya hay una impresora llamada "${imp.nombre}"`);
    if (imp.modo === 'com' && o.modo === 'com' && o.puerto === imp.puerto) throw new Error(`El puerto ${imp.puerto} ya lo usa la impresora "${o.nombre}"`);
    if (imp.modo === 'red' && o.modo === 'red' && o.host === imp.host && o.puertoRed === imp.puertoRed)
      throw new Error(`Esa IP ya la usa la impresora "${o.nombre}"`);
  }
}

function crearImpresora(b) {
  const lista = impresoras();
  if (lista.length >= MAX_IMPRESORAS) throw new Error(`Se pueden configurar hasta ${MAX_IMPRESORAS} impresoras`);
  const imp = { ...validarImpresora(b), id: Math.max(0, ...lista.map((i) => i.id)) + 1 };
  comprobarDuplicados(lista, imp);
  escribir('impresoras', [...lista, imp]);
  // la primera impresora toma todas las tareas que estaban en PDF
  if (!lista.length) {
    const a = asignaciones();
    escribir('asignaciones', { ...a, ...Object.fromEntries(DOCUMENTOS.map((d) => [d, a[d] ?? imp.id])) });
  }
  avisar();
  return imp;
}

function actualizarImpresora(id, b) {
  const lista = impresoras();
  const actual = lista.find((i) => i.id === Number(id));
  if (!actual) throw new Error('Impresora no encontrada');
  const imp = { ...validarImpresora(b, actual), id: actual.id };
  comprobarDuplicados(lista, imp);
  escribir('impresoras', lista.map((i) => (i.id === imp.id ? imp : i)));
  avisar();
  procesar(imp.id);
  return imp;
}

function eliminarImpresora(id) {
  id = Number(id);
  escribir('impresoras', impresoras().filter((i) => i.id !== id));
  const a = asignaciones();
  for (const d of DOCUMENTOS) if (a[d] === id) a[d] = null;
  escribir('asignaciones', a);
  db.prepare("UPDATE cola_impresion SET estado = 'cancelado' WHERE impresora_id = ? AND estado IN ('pendiente','error')").run(id);
  delete estados[id];
  avisar();
}

function guardarAsignaciones(b) {
  const a = asignaciones();
  const ids = new Set(impresoras().map((i) => i.id));
  for (const d of DOCUMENTOS) {
    if (b[d] === undefined) continue;
    const v = b[d] === '' || b[d] === null ? null : Number(b[d]);
    if (v !== null && !ids.has(v)) throw new Error('Impresora no encontrada');
    a[d] = v;
  }
  if (b.autoComandas !== undefined) a.autoComandas = si(b.autoComandas);
  if (b.copiasComanda !== undefined) a.copiasComanda = Math.max(1, Math.min(3, parseInt(b.copiasComanda, 10) || 1));
  escribir('asignaciones', a);
  avisar();
  return a;
}

// ---------------- estado y avisos ----------------
const estados = {}; // por impresora: { ultimoError, ultimoErrorEn, ultimoImpresoEn }
const estadoDe = (id) => (estados[id] ||= { ultimoError: '', ultimoErrorEn: null, ultimoImpresoEn: null });
let emitir = () => {};
let alImprimir = () => {};
/** index.js entrega cómo avisar en tiempo real y qué hacer al imprimir un trabajo */
function configurar(o) {
  emitir = o.emitir || emitir;
  alImprimir = o.alImprimir || alImprimir;
}

function resumen() {
  const a = asignaciones();
  const cuentas = new Map(
    db
      .prepare(
        `SELECT impresora_id AS id, SUM(estado = 'pendiente') AS pendientes, SUM(estado = 'error') AS errores
         FROM cola_impresion WHERE estado IN ('pendiente','error') GROUP BY impresora_id`
      )
      .all()
      .map((r) => [r.id, r])
  );
  const lista = impresoras().map((i) => {
    const c = cuentas.get(i.id) || {};
    const e = estadoDe(i.id);
    return {
      id: i.id,
      nombre: i.nombre,
      modo: i.modo,
      tareas: DOCUMENTOS.filter((d) => a[d] === i.id),
      pendientes: c.pendientes || 0,
      errores: c.errores || 0,
      ok: !(c.errores > 0),
      ultimoError: e.ultimoError,
      ultimoImpresoEn: e.ultimoImpresoEn,
    };
  });
  const asignada = (d) => lista.some((i) => i.id === a[d]);
  return {
    activa: lista.length > 0,
    comanda: asignada('comanda'),
    precuenta: asignada('precuenta'),
    comprobante: asignada('comprobante'),
    autoComandas: asignada('comanda') && a.autoComandas,
    pendientes: lista.reduce((s, i) => s + i.pendientes, 0),
    errores: lista.reduce((s, i) => s + i.errores, 0),
    impresoras: lista,
  };
}
const avisar = () => emitir('impresora', resumen());

function cola(limite = 40) {
  const nombres = new Map(impresoras().map((i) => [i.id, i.nombre]));
  return db
    .prepare(
      `SELECT id, impresora_id, tipo, ref, titulo, estado, intentos, error, creado_en, impreso_en FROM cola_impresion
       ORDER BY CASE WHEN estado IN ('pendiente','error') THEN 0 ELSE 1 END, id DESC LIMIT ?`
    )
    .all(limite)
    .map((t) => ({ ...t, impresora: nombres.get(t.impresora_id) || '(quitada)' }));
}

// ---------------- encolar ----------------
function encolar(impresoraId, tipo, ref, titulo, datos, copias = 1) {
  const ins = db.prepare('INSERT INTO cola_impresion (impresora_id, tipo, ref, titulo, datos, creado_en) VALUES (?,?,?,?,?,?)');
  for (let i = 0; i < copias; i++) ins.run(impresoraId, tipo, ref ?? null, titulo, datos, ahora());
  avisar();
  procesar(impresoraId);
}

/** Quita de la cola los trabajos aún no impresos de un documento (al reemplazarlos por otro) */
function descartarPendientes(tipo, ref) {
  db.prepare("UPDATE cola_impresion SET estado = 'cancelado' WHERE tipo = ? AND ref = ? AND estado IN ('pendiente','error')").run(tipo, ref);
}

/** Reintenta ya: un trabajo (id), todo lo de una impresora (impresoraId) o todo */
function reintentar({ id, impresoraId } = {}) {
  if (id) db.prepare("UPDATE cola_impresion SET estado = 'pendiente' WHERE id = ? AND estado = 'error'").run(id);
  else if (impresoraId) db.prepare("UPDATE cola_impresion SET estado = 'pendiente' WHERE impresora_id = ? AND estado = 'error'").run(impresoraId);
  else db.prepare("UPDATE cola_impresion SET estado = 'pendiente' WHERE estado = 'error'").run();
  for (const t of Object.values(temporizadores)) clearTimeout(t);
  avisar();
  procesarTodas();
}

function cancelar(id) {
  const t = db.prepare('SELECT impresora_id FROM cola_impresion WHERE id = ?').get(id);
  db.prepare("UPDATE cola_impresion SET estado = 'cancelado' WHERE id = ? AND estado IN ('pendiente','error')").run(id);
  avisar();
  if (t) procesar(t.impresora_id);
}

// ---------------- envío (una cola por impresora) ----------------
const trabajando = {};
const temporizadores = {};
const fallosSeguidos = {};

/** Procesa en orden la cola de una impresora. Si un trabajo falla, espera y lo reintenta antes de seguir. */
async function procesar(impresoraId) {
  const id = Number(impresoraId);
  if (trabajando[id]) return;
  trabajando[id] = true;
  try {
    for (;;) {
      const imp = impresora(id);
      if (!imp) break;
      const t = db
        .prepare("SELECT * FROM cola_impresion WHERE impresora_id = ? AND estado IN ('pendiente','error') ORDER BY id LIMIT 1")
        .get(id);
      if (!t) break;
      const e = estadoDe(id);
      try {
        await enviar(imp, Buffer.from(t.datos), t);
        db.prepare("UPDATE cola_impresion SET estado = 'impreso', impreso_en = ?, error = '' WHERE id = ?").run(ahora(), t.id);
        e.ultimoImpresoEn = ahora();
        e.ultimoError = '';
        fallosSeguidos[id] = 0;
        try {
          alImprimir(t);
        } catch (err) {
          console.error('Impresora:', err.message);
        }
        avisar();
      } catch (err) {
        fallosSeguidos[id] = (fallosSeguidos[id] || 0) + 1;
        const msg = String(err.message || err).slice(0, 300);
        db.prepare("UPDATE cola_impresion SET estado = 'error', intentos = intentos + 1, error = ? WHERE id = ?").run(msg, t.id);
        e.ultimoError = msg;
        e.ultimoErrorEn = ahora();
        console.error(`Impresora "${imp.nombre}": no se pudo imprimir "${t.titulo}": ${msg}`);
        // reintento: 5 s, 10 s, 20 s... hasta 60 s
        const espera = Math.min(60, 5 * 2 ** Math.min(fallosSeguidos[id] - 1, 4)) * 1000;
        clearTimeout(temporizadores[id]);
        temporizadores[id] = setTimeout(() => procesar(id), espera);
        temporizadores[id].unref?.();
        avisar();
        break;
      }
    }
  } finally {
    trabajando[id] = false;
  }
}
const procesarTodas = () => impresoras().forEach((i) => procesar(i.id));

function enviar(imp, datos, trabajo) {
  if (imp.modo === 'archivo') {
    fs.mkdirSync(DIR_ARCHIVOS, { recursive: true });
    const nombre = imp.nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    fs.writeFileSync(path.join(DIR_ARCHIVOS, `${String(trabajo.id).padStart(5, '0')}-${nombre}-${trabajo.tipo}.bin`), datos);
    return Promise.resolve();
  }
  if (imp.modo === 'red') return enviarRed(imp.host, imp.puertoRed, datos);
  if (imp.modo === 'com') return powershell('com', ['-Puerto', imp.puerto, '-Baudios', String(imp.baudios)], datos);
  if (imp.modo === 'windows') return powershell('windows', ['-Impresora', imp.nombreWindows], datos);
  return Promise.reject(new Error('Impresora mal configurada'));
}

function enviarRed(host, puerto, datos) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port: puerto });
    const fin = (err) => {
      s.destroy();
      err ? reject(err) : resolve();
    };
    s.setTimeout(10000, () => fin(new Error(`La impresora ${host}:${puerto} no responde`)));
    s.on('error', (e) => fin(new Error(`No se pudo conectar con ${host}:${puerto} (${e.code || e.message})`)));
    s.on('connect', () => s.end(datos));
    s.on('close', (huboError) => !huboError && resolve());
  });
}

// ---------------- Windows (PowerShell, sin instalar nada) ----------------
const SCRIPTS = {
  // Escribe directo en el puerto COM (impresora Bluetooth emparejada o USB-serie)
  com: `param([string]$Puerto, [int]$Baudios, [string]$Archivo)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$datos = [IO.File]::ReadAllBytes($Archivo)
$p = New-Object System.IO.Ports.SerialPort $Puerto, $Baudios, 'None', 8, 'One'
$p.Handshake = 'None'
$p.WriteTimeout = 20000
try {
  $p.Open()
  $p.Write($datos, 0, $datos.Length)
  $limite = (Get-Date).AddSeconds(20)
  while ($p.BytesToWrite -gt 0 -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 50 }
  Start-Sleep -Milliseconds 400
} finally { if ($p.IsOpen) { $p.Close() } }
`,
  // Envía los bytes tal cual (RAW) a una impresora instalada en Windows
  windows: `param([string]$Impresora, [string]$Archivo)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ImpresionRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string nombre, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int nivel, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int n, out int escritos);
  public static void Enviar(string impresora, byte[] datos) {
    IntPtr h;
    if (!OpenPrinter(impresora, out h, IntPtr.Zero)) throw new Exception("No se encontro la impresora '" + impresora + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      var di = new DOCINFO { pDocName = "Comanda", pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("No se pudo iniciar la impresion (error " + Marshal.GetLastWin32Error() + ")");
      try {
        StartPagePrinter(h);
        int escritos;
        if (!WritePrinter(h, datos, datos.Length, out escritos) || escritos != datos.Length)
          throw new Exception("No se pudo enviar el ticket (error " + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[ImpresionRaw]::Enviar($Impresora, [IO.File]::ReadAllBytes($Archivo))
`,
  // Lista impresoras de Windows y puertos COM (con su nombre, para reconocer el Bluetooth)
  dispositivos: `$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$impresoras = @(Get-CimInstance Win32_Printer | ForEach-Object { $_.Name })
$puertos = @()
foreach ($d in Get-CimInstance Win32_PnPEntity) {
  if ($d.Name -match '\\((COM\\d+)\\)') { $puertos += [pscustomobject]@{ puerto = $Matches[1]; nombre = $d.Name } }
}
foreach ($p in [System.IO.Ports.SerialPort]::GetPortNames()) {
  if (-not ($puertos | Where-Object { $_.puerto -eq $p })) { $puertos += [pscustomobject]@{ puerto = $p; nombre = $p } }
}
[pscustomobject]@{ impresoras = $impresoras; puertos = $puertos } | ConvertTo-Json -Compress -Depth 3
`,
};

function rutaScript(nombre) {
  fs.mkdirSync(DIR, { recursive: true });
  const archivo = path.join(DIR, `${nombre}.ps1`);
  // con BOM para que PowerShell 5 lea bien los acentos
  const contenido = `﻿${SCRIPTS[nombre]}`;
  if (!fs.existsSync(archivo) || fs.readFileSync(archivo, 'utf8') !== contenido) fs.writeFileSync(archivo, contenido, 'utf8');
  return archivo;
}

function ejecutarPS(nombre, args, segundos = 45) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Disponible solo con el servidor en Windows'));
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', rutaScript(nombre), ...args],
      { windowsHide: true }
    );
    let salida = '';
    let errores = '';
    ps.stdout.on('data', (d) => (salida += d));
    ps.stderr.on('data', (d) => (errores += d));
    const reloj = setTimeout(() => {
      ps.kill();
      reject(new Error('La impresora no respondió a tiempo (¿está encendida y conectada?)'));
    }, segundos * 1000);
    ps.on('error', (e) => {
      clearTimeout(reloj);
      reject(new Error(`No se pudo ejecutar PowerShell: ${e.message}`));
    });
    ps.on('close', (codigo) => {
      clearTimeout(reloj);
      if (codigo === 0) resolve(salida);
      else reject(new Error(limpiarErrorPS(errores) || `PowerShell terminó con código ${codigo}`));
    });
  });
}

// Deja solo la primera línea útil del error de PowerShell
function limpiarErrorPS(t) {
  const lineas = String(t)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(En |At |\+|CategoryInfo|FullyQualifiedErrorId|~)/.test(l));
  return (lineas[0] || '').replace(/^Exception calling "\w+" with "\d+" argument\(s\): /, '').replace(/^"|"$/g, '');
}

async function powershell(nombre, args, datos) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `trabajo-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(tmp, datos);
  try {
    await ejecutarPS(nombre, [...args, '-Archivo', tmp]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function dispositivos() {
  if (process.platform !== 'win32') return { impresoras: [], puertos: [], aviso: 'La búsqueda de dispositivos funciona con el servidor en Windows.' };
  const json = JSON.parse((await ejecutarPS('dispositivos', [], 30)).trim() || '{}');
  const lista = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
  return {
    impresoras: lista(json.impresoras).filter(Boolean),
    puertos: lista(json.puertos).filter((p) => p && p.puerto),
  };
}

// trabajos que quedaron a medias si el servidor se apagó
setTimeout(procesarTodas, 2000).unref?.();

module.exports = {
  DOCUMENTOS,
  MAX_IMPRESORAS,
  impresoras,
  impresora,
  crearImpresora,
  actualizarImpresora,
  eliminarImpresora,
  asignaciones,
  guardarAsignaciones,
  destino,
  opciones,
  resumen,
  cola,
  encolar,
  descartarPendientes,
  reintentar,
  cancelar,
  dispositivos,
  configurar,
};
