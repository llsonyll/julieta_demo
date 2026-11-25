// Configuración del servidor: valores por defecto -> config.json -> config.local.json
// config.local.json es opcional y no se sube a git: cada local pone ahí sus propios datos
// (RUC, dirección, puerto...) para que `git pull` no choque con config.json.
//
// Uso desde los scripts de instalación:  node server/config.js puerto
const path = require('node:path');
const fs = require('node:fs');

const RAIZ = path.join(__dirname, '..');

const POR_DEFECTO = {
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
};

class ErrorConfig extends Error {}

// Lee un archivo JSON de configuración. Devuelve {} si es opcional y no existe.
function leerJSON(nombre, { opcional = false } = {}) {
  const ruta = path.join(RAIZ, nombre);
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && opcional) return {};
    throw new ErrorConfig(`No se pudo leer ${nombre} (${ruta}): ${e.message}`);
  }
  // El Bloc de notas de Windows puede guardar "UTF-8 con BOM"; JSON.parse no lo acepta.
  texto = texto.replace(/^﻿/, '');
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch (e) {
    throw new ErrorConfig(
      `${nombre} tiene un error de formato: ${e.message}\n` +
        `  Archivo: ${ruta}\n` +
        '  Revise comas, comillas y llaves (puede validarlo en https://jsonlint.com).'
    );
  }
  if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) {
    throw new ErrorConfig(`${nombre} debe contener un objeto JSON entre llaves { ... }.\n  Archivo: ${ruta}`);
  }
  return datos;
}

function cargarConfig() {
  return Object.assign(
    {},
    POR_DEFECTO,
    leerJSON('config.json', { opcional: true }),
    leerJSON('config.local.json', { opcional: true })
  );
}

module.exports = { cargarConfig, ErrorConfig, POR_DEFECTO };

// Ejecutado directamente: imprime una clave (o toda la configuración) para los scripts.
if (require.main === module) {
  try {
    const config = cargarConfig();
    const clave = process.argv[2];
    console.log(clave ? String(config[clave] ?? '') : JSON.stringify(config, null, 2));
  } catch (e) {
    if (!(e instanceof ErrorConfig)) throw e;
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}
