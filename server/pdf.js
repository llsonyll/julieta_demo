// Generación de tickets en PDF de 80 mm (ticket de cocina y comprobante de pago).
// Cada documento se arma como una lista de bloques; primero se mide su alto
// para que la página tenga exactamente el largo del ticket.
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');

const ANCHO = 226.77; // 80 mm en puntos
const MARGEN = 12;
const UTIL = ANCHO - MARGEN * 2;

// Logo del comprobante, en negro para impresora térmica (sin el archivo se imprime el nombre).
// Se regenera desde public/logo.svg si cambia el logo.
const ARCHIVO_LOGO = path.join(__dirname, 'logo-comprobante.png');
const LOGO = fs.existsSync(ARCHIVO_LOGO) ? fs.readFileSync(ARCHIVO_LOGO) : null;
const ANCHO_LOGO = 150; // puntos (~53 mm)

function fuente(doc, b) {
  doc.font(b.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(b.tam || 10);
}

function alto(doc, b) {
  if (b.t === 'espacio') return b.alto;
  if (b.t === 'linea') return 10;
  if (b.t === 'imagen') return b.alto + 6;
  fuente(doc, b);
  if (b.t === 'fila') {
    const anchoDer = doc.widthOfString(b.der);
    return Math.max(doc.heightOfString(b.izq, { width: UTIL - anchoDer - 8 }), doc.heightOfString(b.der)) + (b.sep ?? 2);
  }
  return doc.heightOfString(b.texto, { width: UTIL - (b.sangria || 0), align: b.alinear }) + (b.sep ?? 2);
}

function dibujar(doc, bloques, medidor) {
  let y = MARGEN;
  for (const b of bloques) {
    const h = alto(medidor, b);
    if (b.t === 'imagen') {
      doc.image(b.src, (ANCHO - b.ancho) / 2, y, { width: b.ancho });
    } else if (b.t === 'linea') {
      doc.save().moveTo(MARGEN, y + 5).lineTo(ANCHO - MARGEN, y + 5).lineWidth(0.8).dash(2, { space: 2 }).stroke().restore();
    } else if (b.t === 'fila') {
      fuente(doc, b);
      const anchoDer = doc.widthOfString(b.der);
      doc.text(b.izq, MARGEN, y, { width: UTIL - anchoDer - 8 });
      doc.text(b.der, ANCHO - MARGEN - anchoDer, y, { lineBreak: false });
    } else if (b.t !== 'espacio') {
      fuente(doc, b);
      doc.text(b.texto, MARGEN + (b.sangria || 0), y, { width: UTIL - (b.sangria || 0), align: b.alinear });
    }
    y += h;
  }
}

/** Genera un PDF con una página por cada lista de bloques. Devuelve un Buffer. */
function generarPDF(paginas, titulo) {
  return new Promise((resolve, reject) => {
    const medidor = new PDFDocument({ size: [ANCHO, 2000], margin: 0 });
    const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: titulo } });
    const partes = [];
    doc.on('data', (c) => partes.push(c));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    for (const bloques of paginas) {
      const total = bloques.reduce((s, b) => s + alto(medidor, b), 0);
      doc.addPage({ size: [ANCHO, Math.ceil(total + MARGEN * 2 + 6)], margin: 0 });
      dibujar(doc, bloques, medidor);
    }
    medidor.end();
    doc.end();
  });
}

const texto = (t, tam = 10, extra = {}) => ({ t: 'texto', texto: String(t ?? ''), tam, ...extra });
const centro = (t, tam = 10, negrita = false) => texto(t, tam, { alinear: 'center', negrita });
const linea = () => ({ t: 'linea' });
const espacio = (a = 4) => ({ t: 'espacio', alto: a });
const fila = (izq, der, tam = 10, negrita = false) => ({ t: 'fila', izq: String(izq), der: String(der), tam, negrita });
// Alto según las proporciones del PNG (ancho y alto están en los bytes 16-23 de la cabecera)
const imagen = (src, ancho) => ({ t: 'imagen', src, ancho, alto: (ancho * src.readUInt32BE(20)) / src.readUInt32BE(16) });

function lineasGuarnicion(it) {
  const r = [];
  if (it.guarnicion_defecto && !it.guarnicion_base) r.push({ txt: `SIN ${it.guarnicion_defecto.toUpperCase()}`, cambio: true });
  else if (it.guarnicion_base && it.guarnicion_defecto && it.guarnicion_base !== it.guarnicion_defecto)
    r.push({ txt: `CAMBIO: ${it.guarnicion_base} (en vez de ${it.guarnicion_defecto})`, cambio: true });
  else if (it.guarnicion_base) r.push({ txt: `+ ${it.guarnicion_base}`, cambio: false });
  if (it.guarnicion_eleccion) r.push({ txt: `+ ${it.guarnicion_eleccion}`, cambio: false });
  return r;
}

/** Ticket para cocina: letra grande, sin precios. */
function ticketCocina(c, momento) {
  const b = [centro('COCINA', 9), centro(`#${c.numero_dia}`, 26, true)];
  if (c.tipo === 'local') b.push(centro(`MESA ${c.mesa_numero ?? '?'}`, 20, true));
  else {
    b.push(centro('PARA LLEVAR', 18, true));
    if (c.cliente) b.push(centro(c.cliente, 13, true));
  }
  if (c.ticket_modificado) b.push(espacio(2), centro('*** COMANDA MODIFICADA ***', 11, true));
  b.push(centro(`${String(c.enviado_en || c.creado_en).slice(11, 16)} · ${c.mozo_nombre || ''}`, 10), linea());
  for (const it of c.items) {
    b.push(texto(`${it.cantidad} x ${it.nombre}`, 14, { negrita: true, sep: 1 }));
    for (const g of lineasGuarnicion(it)) b.push(texto(g.txt, 12, { negrita: g.cambio, sep: 1, sangria: 18 }));
    if (it.nota) b.push(texto(`NOTA: ${it.nota}`, 12, { negrita: true, sep: 1, sangria: 18 }));
    b.push(espacio(5));
  }
  if (c.nota) b.push(linea(), texto(`NOTA: ${c.nota}`, 13, { negrita: true }));
  b.push(linea(), centro(`Impreso ${momento}`, 8));
  return b;
}

/** Comprobante de pago (interno) para el cliente. */
function comprobante({ cobro, comandas, config, cajero }) {
  const dinero = (n) => `${config.moneda} ${Number(n || 0).toFixed(2)}`;
  const b = [LOGO ? imagen(LOGO, ANCHO_LOGO) : centro(config.nombreRestaurante, 14, true)];
  if (config.ruc) b.push(centro(`RUC ${config.ruc}`, 9));
  if (config.direccion) b.push(centro(config.direccion, 9));
  if (config.telefono) b.push(centro(`Tel. ${config.telefono}`, 9));
  b.push(linea(), centro('COMPROBANTE DE PAGO', 11, true), centro(`N° ${String(cobro.id).padStart(6, '0')}`, 10));
  b.push(centro(`${cobro.creado_en.slice(0, 10).split('-').reverse().join('/')}  ${cobro.creado_en.slice(11, 16)}`, 9), linea());

  const primera = comandas[0];
  b.push(texto(primera.tipo === 'local' ? `Mesa: ${primera.mesa_numero}` : `Para llevar${primera.cliente ? `: ${primera.cliente}` : ''}`, 10, { negrita: true }));
  const mozos = [...new Set(comandas.map((c) => c.mozo_nombre).filter(Boolean))];
  if (mozos.length) b.push(texto(`Atendió: ${mozos.join(', ')}`, 9));
  b.push(texto(`Comanda${comandas.length > 1 ? 's' : ''}: ${comandas.map((c) => `#${c.numero_dia}`).join(', ')}`, 9));
  b.push(linea(), fila('Cant. Descripción', 'Importe', 9, true), espacio(2));

  // agrupa líneas iguales de todas las comandas
  const grupos = new Map();
  for (const c of comandas)
    for (const it of c.items) {
      const det = [it.guarnicion_base, it.guarnicion_eleccion].filter(Boolean).join(' + ');
      const k = `${it.nombre}|${det}|${it.precio}`;
      const g = grupos.get(k) || { nombre: it.nombre, det, precio: it.precio, cantidad: 0 };
      g.cantidad += it.cantidad;
      grupos.set(k, g);
    }
  for (const g of grupos.values()) {
    b.push(fila(`${g.cantidad} x ${g.nombre}`, dinero(g.precio * g.cantidad), 10));
    if (g.det) b.push(texto(g.det, 8, { sep: 3, sangria: 14 }));
  }
  b.push(linea(), fila('TOTAL', dinero(cobro.total), 14, true), espacio(4));
  b.push(fila('Forma de pago', cobro.metodo, 10));
  if (cobro.recibido != null) {
    b.push(fila('Recibido', dinero(cobro.recibido), 10), fila('Vuelto', dinero(cobro.recibido - cobro.total), 10, true));
  }
  if (cajero) b.push(texto(`Cobrado por: ${cajero}`, 8));
  b.push(linea());
  if (config.pieComprobante) b.push(centro(config.pieComprobante, 10, true));
  if (config.avisoComprobante) b.push(centro(config.avisoComprobante, 7));
  return b;
}

module.exports = { generarPDF, ticketCocina, comprobante };
