// Ticketera térmica: ajustes, cola de impresión con reintentos y envío a la impresora.
//
// Formas de conexión (ajuste "modo"):
//   com      Bluetooth o USB que Windows expone como puerto COM (ej: COM5). Se escribe directo.
//   windows  Impresora instalada en Windows con su controlador (USB, Bluetooth o red). Se envía en RAW.
//   red      Impresora con IP propia (puerto 9100).
//   archivo  Solo para pruebas: guarda cada ticket en data/impresiones/*.bin
//   ninguna  Sin ticketera: todo se imprime en PDF desde el navegador, como antes.
//
// Cada trabajo se guarda en la tabla cola_impresion antes de enviarse. Si la impresora no
// responde (Bluetooth dormido, apagada, sin papel), se reintenta solo y en orden.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { db, ahora } = require('./db');

const DIR = path.join(__dirname, '..', 'data', 'impresora');
const DIR_ARCHIVOS = path.join(__dirname, '..', 'data', 'impresiones');

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
// lo ya impreso o cancelado hace más de 7 días se borra
db.prepare("DELETE FROM cola_impresion WHERE estado IN ('impreso','cancelado') AND creado_en < datetime('now','localtime','-7 days')").run();

// ---------------- ajustes ----------------
const POR_DEFECTO = {
  modo: 'ninguna',
  puerto: '', // COM5
  baudios: 9600,
  nombre: '', // nombre de la impresora en Windows
  host: '', // IP en modo red
  puertoRed: 9100,
  columnas: 48, // 80 mm = 48 (algunos modelos 42); 58 mm = 32
  pagina: 'cp850', // página de códigos para los acentos: cp850 o wpc1252
  cortar: true,
  logo: true,
  autoComandas: true, // imprimir cada comanda al enviarla a cocina
  caja: true, // precuenta y comprobante también salen por la ticketera
  copiasComanda: 1,
};
const MODOS = ['ninguna', 'com', 'windows', 'red', 'archivo'];

function ajustes() {
  const fila = db.prepare("SELECT valor FROM ajustes WHERE clave = 'impresora'").get();
  let guardado = {};
  try {
    guardado = fila ? JSON.parse(fila.valor) : {};
  } catch {}
  return { ...POR_DEFECTO, ...guardado };
}

/** Valida y guarda los ajustes. Lanza Error con un mensaje para el usuario si algo no cuadra. */
function guardarAjustes(b) {
  const a = { ...ajustes() };
  const txt = (v, max = 120) => String(v ?? '').trim().slice(0, max);
  const si = (v) => v === true || v === 1 || v === '1' || v === 'true';
  if (b.modo !== undefined) {
    if (!MODOS.includes(b.modo)) throw new Error('Forma de conexión inválida');
    a.modo = b.modo;
  }
  if (b.puerto !== undefined) a.puerto = txt(b.puerto, 20).toUpperCase();
  if (b.baudios !== undefined) a.baudios = parseInt(b.baudios, 10) || 9600;
  if (b.nombre !== undefined) a.nombre = txt(b.nombre);
  if (b.host !== undefined) a.host = txt(b.host, 60);
  if (b.puertoRed !== undefined) a.puertoRed = parseInt(b.puertoRed, 10) || 9100;
  if (b.columnas !== undefined) a.columnas = [32, 42, 48].includes(Number(b.columnas)) ? Number(b.columnas) : 48;
  if (b.pagina !== undefined) a.pagina = b.pagina === 'wpc1252' ? 'wpc1252' : 'cp850';
  for (const k of ['cortar', 'logo', 'autoComandas', 'caja']) if (b[k] !== undefined) a[k] = si(b[k]);
  if (b.copiasComanda !== undefined) a.copiasComanda = Math.max(1, Math.min(3, parseInt(b.copiasComanda, 10) || 1));

  if (a.modo === 'com' && !/^COM\d{1,3}$/.test(a.puerto)) throw new Error('Indique el puerto COM de la impresora (ej: COM5)');
  if (a.modo === 'windows' && !a.nombre) throw new Error('Indique el nombre de la impresora en Windows');
  if (a.modo === 'red' && !/^[a-zA-Z0-9.-]+$/.test(a.host)) throw new Error('Indique la IP de la impresora (ej: 192.168.1.50)');
  if (['com', 'windows'].includes(a.modo) && process.platform !== 'win32')
    throw new Error('Esa forma de conexión solo funciona con el servidor en Windows');

  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('impresora', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor").run(
    JSON.stringify(a)
  );
  avisar();
  procesar();
  return a;
}

const activa = () => ajustes().modo !== 'ninguna';

// ---------------- estado y avisos ----------------
const estado = { ultimoError: '', ultimoErrorEn: null, ultimoImpresoEn: null, imprimiendo: false };
let emitir = () => {};
let alImprimir = () => {};
/** index.js entrega cómo avisar en tiempo real y qué hacer al imprimir un trabajo */
function configurar(opciones) {
  emitir = opciones.emitir || emitir;
  alImprimir = opciones.alImprimir || alImprimir;
}

function resumen() {
  const a = ajustes();
  const c = db
    .prepare(
      `SELECT SUM(estado = 'pendiente') AS pendientes, SUM(estado = 'error') AS errores FROM cola_impresion
       WHERE estado IN ('pendiente','error')`
    )
    .get();
  return {
    activa: a.modo !== 'ninguna',
    caja: a.modo !== 'ninguna' && a.caja,
    autoComandas: a.modo !== 'ninguna' && a.autoComandas,
    modo: a.modo,
    pendientes: c.pendientes || 0,
    errores: c.errores || 0,
    ok: !(c.errores > 0),
    ultimoError: estado.ultimoError,
    ultimoErrorEn: estado.ultimoErrorEn,
    ultimoImpresoEn: estado.ultimoImpresoEn,
  };
}
const avisar = () => emitir('impresora', resumen());

function cola(limite = 40) {
  return db
    .prepare(
      `SELECT id, tipo, ref, titulo, estado, intentos, error, creado_en, impreso_en FROM cola_impresion
       ORDER BY CASE WHEN estado IN ('pendiente','error') THEN 0 ELSE 1 END, id DESC LIMIT ?`
    )
    .all(limite);
}

// ---------------- encolar ----------------
function encolar(tipo, ref, titulo, datos, copias = 1) {
  const ins = db.prepare('INSERT INTO cola_impresion (tipo, ref, titulo, datos, creado_en) VALUES (?,?,?,?,?)');
  for (let i = 0; i < copias; i++) ins.run(tipo, ref ?? null, titulo, datos, ahora());
  avisar();
  procesar();
}

/** Quita de la cola los trabajos aún no impresos de una comanda (al reemplazarlos por otro) */
function descartarPendientes(tipo, ref) {
  db.prepare("UPDATE cola_impresion SET estado = 'cancelado' WHERE tipo = ? AND ref = ? AND estado IN ('pendiente','error')").run(tipo, ref);
}

function reintentar(id) {
  const where = id ? 'id = ? AND ' : '';
  db.prepare(`UPDATE cola_impresion SET estado = 'pendiente' WHERE ${where}estado = 'error'`).run(...(id ? [id] : []));
  clearTimeout(temporizador);
  avisar();
  procesar();
}

function cancelar(id) {
  db.prepare("UPDATE cola_impresion SET estado = 'cancelado' WHERE id = ? AND estado IN ('pendiente','error')").run(id);
  avisar();
  procesar();
}

// ---------------- envío ----------------
let trabajando = false;
let temporizador = null;
let fallosSeguidos = 0;

/** Procesa la cola en orden. Si un trabajo falla, espera y lo reintenta antes de seguir con los demás. */
async function procesar() {
  if (trabajando) return;
  trabajando = true;
  try {
    for (;;) {
      const a = ajustes();
      if (a.modo === 'ninguna') break;
      const t = db.prepare("SELECT * FROM cola_impresion WHERE estado IN ('pendiente','error') ORDER BY id LIMIT 1").get();
      if (!t) break;
      estado.imprimiendo = true;
      try {
        await enviar(a, Buffer.from(t.datos), t);
        db.prepare("UPDATE cola_impresion SET estado = 'impreso', impreso_en = ?, error = '' WHERE id = ?").run(ahora(), t.id);
        estado.ultimoImpresoEn = ahora();
        estado.ultimoError = '';
        fallosSeguidos = 0;
        try {
          alImprimir(t);
        } catch (e) {
          console.error('Impresora:', e.message);
        }
        avisar();
      } catch (e) {
        fallosSeguidos++;
        const msg = String(e.message || e).slice(0, 300);
        db.prepare("UPDATE cola_impresion SET estado = 'error', intentos = intentos + 1, error = ? WHERE id = ?").run(msg, t.id);
        estado.ultimoError = msg;
        estado.ultimoErrorEn = ahora();
        console.error(`Impresora: no se pudo imprimir "${t.titulo}": ${msg}`);
        // reintento: 5 s, 10 s, 20 s... hasta 60 s
        const espera = Math.min(60, 5 * 2 ** Math.min(fallosSeguidos - 1, 4)) * 1000;
        clearTimeout(temporizador);
        temporizador = setTimeout(procesar, espera);
        temporizador.unref?.();
        avisar();
        break;
      }
    }
  } finally {
    estado.imprimiendo = false;
    trabajando = false;
  }
}

function enviar(a, datos, trabajo) {
  if (a.modo === 'archivo') {
    fs.mkdirSync(DIR_ARCHIVOS, { recursive: true });
    fs.writeFileSync(path.join(DIR_ARCHIVOS, `${String(trabajo.id).padStart(5, '0')}-${trabajo.tipo}.bin`), datos);
    return Promise.resolve();
  }
  if (a.modo === 'red') return enviarRed(a.host, a.puertoRed, datos);
  if (a.modo === 'com') return powershell('com', ['-Puerto', a.puerto, '-Baudios', String(a.baudios)], datos);
  if (a.modo === 'windows') return powershell('windows', ['-Impresora', a.nombre], datos);
  return Promise.reject(new Error('Ticketera no configurada'));
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
setTimeout(procesar, 2000).unref?.();

module.exports = {
  ajustes,
  guardarAjustes,
  activa,
  resumen,
  cola,
  encolar,
  descartarPendientes,
  reintentar,
  cancelar,
  dispositivos,
  configurar,
  hostname: os.hostname(),
};
