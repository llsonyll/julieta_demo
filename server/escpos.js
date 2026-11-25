// Convierte los documentos (los mismos bloques que usa pdf.js) a comandos ESC/POS
// para impresoras térmicas de tickets (Xprinter, Epson y compatibles).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ESC = 0x1b;
const GS = 0x1d;
const PUNTOS_POR_PT = 203 / 72; // 203 dpi
const ANCHO_UTIL_PT = 226.77 - 24; // ancho útil de los bloques en pdf.js (80 mm menos márgenes)

// ---------------- texto y páginas de códigos ----------------
// Tabla de caracteres del español en PC850 (la más compatible en Xprinter/Epson)
const CP850 = {
  á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9,
  ü: 0x81, Ü: 0x9a, à: 0x85, è: 0x8a, ì: 0x8d, ò: 0x95, ù: 0x97, ç: 0x87, Ç: 0x80,
  '¿': 0xa8, '¡': 0xad, '°': 0xf8, º: 0xa7, ª: 0xa6, '·': 0xfa, '±': 0xf1, '½': 0xab,
};
const PAGINAS = {
  cp850: { n: 2, codificar: (c) => CP850[c] },
  // Windows-1252: los caracteres latinos coinciden con su código Unicode (0xA0-0xFF)
  wpc1252: { n: 16, codificar: (c) => (c.charCodeAt(0) >= 0xa0 && c.charCodeAt(0) <= 0xff ? c.charCodeAt(0) : undefined) },
};
const EQUIVALENTES = { '—': '-', '–': '-', '“': '"', '”': '"', '‘': "'", '’': "'", '…': '...', '×': 'x', '•': '*', '€': 'EUR' };

/** Pasa un texto a bytes en la página de códigos de la impresora */
function codificar(texto, pagina) {
  const bytes = [];
  for (const ch of String(texto ?? '')) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x20 && cp < 0x7f) {
      bytes.push(cp);
      continue;
    }
    const b = pagina.codificar(ch);
    if (b !== undefined) {
      bytes.push(b);
      continue;
    }
    const eq = EQUIVALENTES[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const c of eq) {
      const x = c.codePointAt(0);
      if (x >= 0x20 && x < 0x7f) bytes.push(x);
      // emojis y otros símbolos se omiten
    }
  }
  return bytes;
}

/** Corta un texto en renglones de `ancho` caracteres, sin partir palabras si se puede */
function partir(texto, ancho) {
  const lineas = [];
  for (const parrafo of String(texto ?? '').split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      let p = palabra;
      while (p.length > ancho) {
        // palabra más larga que el renglón: se parte
        if (actual) {
          lineas.push(actual);
          actual = '';
        }
        lineas.push(p.slice(0, ancho));
        p = p.slice(ancho);
      }
      if (!actual) actual = p;
      else if (actual.length + 1 + p.length <= ancho) actual += ` ${p}`;
      else {
        lineas.push(actual);
        actual = p;
      }
    }
    lineas.push(actual);
  }
  return lineas;
}

// ---------------- logo: PNG -> imagen de puntos ----------------
/** Decodifica un PNG de 8 bits sin entrelazar (gris, gris+alfa, RGB o RGBA). Devuelve { ancho, alto, luz(x,y) } */
function leerPNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('No es un PNG');
  let off = 8;
  let ancho, alto, prof, tipo, entrelazado;
  const idat = [];
  while (off < buf.length) {
    const largo = buf.readUInt32BE(off);
    const nombre = buf.toString('latin1', off + 4, off + 8);
    const datos = buf.subarray(off + 8, off + 8 + largo);
    if (nombre === 'IHDR') {
      ancho = datos.readUInt32BE(0);
      alto = datos.readUInt32BE(4);
      prof = datos[8];
      tipo = datos[9];
      entrelazado = datos[12];
    } else if (nombre === 'IDAT') idat.push(datos);
    else if (nombre === 'IEND') break;
    off += 12 + largo;
  }
  const canales = { 0: 1, 2: 3, 4: 2, 6: 4 }[tipo];
  if (prof !== 8 || !canales || entrelazado) throw new Error('Formato de PNG no soportado para el logo');
  const crudo = zlib.inflateSync(Buffer.concat(idat));
  const fila = ancho * canales;
  const px = Buffer.alloc(fila * alto);
  for (let y = 0; y < alto; y++) {
    const filtro = crudo[y * (fila + 1)];
    for (let i = 0; i < fila; i++) {
      const x = crudo[y * (fila + 1) + 1 + i];
      const a = i >= canales ? px[y * fila + i - canales] : 0;
      const b = y > 0 ? px[(y - 1) * fila + i] : 0;
      const c = i >= canales && y > 0 ? px[(y - 1) * fila + i - canales] : 0;
      let v;
      if (filtro === 0) v = x;
      else if (filtro === 1) v = x + a;
      else if (filtro === 2) v = x + b;
      else if (filtro === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * fila + i] = v & 0xff;
    }
  }
  // luz de 0 (negro) a 255 (blanco); lo transparente cuenta como blanco
  const luz = (x, y) => {
    const i = y * fila + x * canales;
    const gris = canales >= 3 ? (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 : px[i];
    const alfa = canales === 2 ? px[i + 1] : canales === 4 ? px[i + 3] : 255;
    return 255 - ((255 - gris) * alfa) / 255;
  };
  return { ancho, alto, luz };
}

/** Comando GS v 0 (imagen de puntos) con el PNG escalado a `anchoPuntos` */
function imagenPuntos(png, anchoPuntos) {
  const img = leerPNG(png);
  const ancho = Math.min(anchoPuntos, img.ancho) & ~7; // múltiplo de 8
  const alto = Math.max(1, Math.round((img.alto * ancho) / img.ancho));
  const bytesFila = ancho / 8;
  const datos = Buffer.alloc(bytesFila * alto);
  for (let y = 0; y < alto; y++) {
    const sy = Math.min(img.alto - 1, Math.floor((y * img.alto) / alto));
    for (let x = 0; x < ancho; x++) {
      const sx = Math.min(img.ancho - 1, Math.floor((x * img.ancho) / ancho));
      if (img.luz(sx, sy) < 128) datos[y * bytesFila + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([
    Buffer.from([GS, 0x76, 0x30, 0, bytesFila & 0xff, bytesFila >> 8, alto & 0xff, alto >> 8]),
    datos,
  ]);
}

const ARCHIVO_LOGO = path.join(__dirname, 'logo-comprobante.png');
let logoCache = null;
function logoPuntos(anchoPuntos) {
  if (!fs.existsSync(ARCHIVO_LOGO)) return null;
  const clave = `${anchoPuntos}:${fs.statSync(ARCHIVO_LOGO).mtimeMs}`;
  if (logoCache?.clave !== clave) {
    try {
      logoCache = { clave, bytes: imagenPuntos(fs.readFileSync(ARCHIVO_LOGO), anchoPuntos) };
    } catch (e) {
      console.error('No se pudo preparar el logo para la ticketera:', e.message);
      logoCache = { clave, bytes: null };
    }
  }
  return logoCache.bytes;
}

// ---------------- documento ----------------
/**
 * Convierte una o varias páginas de bloques (formato de pdf.js) a ESC/POS.
 * opciones: { columnas (48 en 80 mm), pagina ('cp850'|'wpc1252'), cortar, logo, anchoPuntos (576 en 80 mm) }
 */
function documentoESCPOS(paginas, opciones = {}) {
  const columnas = opciones.columnas || 48;
  const pagina = PAGINAS[opciones.pagina] || PAGINAS.cp850;
  const anchoPuntos = opciones.anchoPuntos || (columnas <= 32 ? 384 : 576);
  const ptPorColumna = ANCHO_UTIL_PT / columnas;
  const out = [];
  const cmd = (...b) => out.push(...b);
  const txt = (s) => out.push(...codificar(s, pagina));

  cmd(ESC, 0x40); // inicializar
  cmd(ESC, 0x74, pagina.n); // página de códigos

  paginas.forEach((bloques, nPagina) => {
    if (nPagina > 0) cmd(ESC, 0x40, ESC, 0x74, pagina.n);
    for (const b of bloques) {
      if (b.t === 'espacio') {
        cmd(ESC, 0x4a, Math.min(255, Math.round(b.alto * PUNTOS_POR_PT))); // avanzar n puntos
        continue;
      }
      if (b.t === 'linea') {
        cmd(ESC, 0x61, 0, GS, 0x21, 0, ESC, 0x45, 0);
        txt('-'.repeat(columnas));
        cmd(0x0a);
        continue;
      }
      if (b.t === 'qr') {
        // QR como imagen de puntos (funciona en cualquier térmica, tenga o no QR propio)
        const escala = Math.max(2, Math.floor(Math.round(anchoPuntos * (b.ancho / ANCHO_UTIL_PT)) / b.tam));
        const lado = b.tam * escala;
        const ancho = (lado + 7) & ~7;
        const bytesFila = ancho / 8;
        const datos = Buffer.alloc(bytesFila * lado);
        for (let y = 0; y < lado; y++)
          for (let x = 0; x < lado; x++)
            if (b.modulos[Math.floor(y / escala) * b.tam + Math.floor(x / escala)]) datos[y * bytesFila + (x >> 3)] |= 0x80 >> (x & 7);
        cmd(ESC, 0x61, 1);
        out.push(GS, 0x76, 0x30, 0, bytesFila & 0xff, bytesFila >> 8, lado & 0xff, lado >> 8, ...datos);
        cmd(0x0a, ESC, 0x61, 0);
        continue;
      }
      if (b.t === 'imagen') {
        const logo = opciones.logo !== false ? logoPuntos(Math.round(anchoPuntos * (b.ancho / ANCHO_UTIL_PT))) : null;
        if (logo) {
          cmd(ESC, 0x61, 1);
          out.push(...logo);
          cmd(0x0a);
        } else if (opciones.nombre) {
          cmd(ESC, 0x61, 1, GS, 0x21, 0x11, ESC, 0x45, 1);
          txt(opciones.nombre);
          cmd(0x0a, GS, 0x21, 0, ESC, 0x45, 0);
        }
        continue;
      }
      // tamaño: enorme (triple), grande (doble alto y ancho), mediano (doble alto) o normal
      const tam = b.tam || 10;
      const factor = tam >= 24 ? 3 : tam >= 18 ? 2 : 1;
      const alto2 = factor === 1 && tam >= 12;
      const cols = Math.floor(columnas / factor);
      cmd(GS, 0x21, factor > 1 ? ((factor - 1) << 4) | (factor - 1) : alto2 ? 0x01 : 0x00);
      cmd(ESC, 0x45, b.negrita ? 1 : 0);

      if (b.t === 'fila') {
        cmd(ESC, 0x61, 0);
        const der = String(b.der);
        const lineas = partir(b.izq, Math.max(8, cols - der.length - 1));
        lineas.forEach((l, i) => {
          txt(i === 0 ? l + ' '.repeat(Math.max(1, cols - l.length - der.length)) + der : l);
          cmd(0x0a);
        });
      } else {
        const centrado = b.alinear === 'center';
        cmd(ESC, 0x61, centrado ? 1 : b.alinear === 'right' ? 2 : 0);
        const sangria = centrado ? 0 : Math.round((b.sangria || 0) / ptPorColumna / factor);
        for (const l of partir(b.texto, Math.max(8, cols - sangria))) {
          txt(' '.repeat(sangria) + l);
          cmd(0x0a);
        }
      }
      cmd(GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x61, 0);
    }
    // fin de cada ticket: avanzar y cortar
    if (opciones.cortar !== false) cmd(ESC, 0x64, 4, GS, 0x56, 0x42, 0x00);
    else cmd(ESC, 0x64, 6);
  });
  return Buffer.from(out);
}

/** Ticket de prueba: confirma conexión, ancho y acentos */
function documentoPrueba(opciones, nombreRestaurante, momento) {
  const columnas = opciones.columnas || 48;
  return documentoESCPOS(
    [
      [
        { t: 'imagen', ancho: 150 },
        { t: 'texto', texto: 'PRUEBA DE IMPRESORA', tam: 14, negrita: true, alinear: 'center' },
        { t: 'texto', texto: nombreRestaurante, tam: 10, alinear: 'center' },
        { t: 'linea' },
        { t: 'texto', texto: 'Acentos: áéíóú ÁÉÍÓÚ ñÑ ¿¡ ü °', tam: 10 },
        { t: 'texto', texto: `Ancho (${columnas} columnas):`, tam: 10 },
        { t: 'texto', texto: '1234567890'.repeat(Math.ceil(columnas / 10)).slice(0, columnas), tam: 10 },
        { t: 'fila', izq: '2 x Malaya frita', der: 'S/ 48.00', tam: 10 },
        { t: 'texto', texto: 'TEXTO GRANDE', tam: 20, negrita: true, alinear: 'center' },
        { t: 'linea' },
        { t: 'texto', texto: `Impreso ${momento}`, tam: 8, alinear: 'center' },
      ],
    ],
    { ...opciones, nombre: nombreRestaurante }
  );
}

module.exports = { documentoESCPOS, documentoPrueba, codificar, partir, leerPNG, PAGINAS };
