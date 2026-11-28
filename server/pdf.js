// Generación de tickets en PDF de 80 mm (ticket de cocina y comprobante de pago).
// Cada documento se arma como una lista de bloques; primero se mide su alto
// para que la página tenga exactamente el largo del ticket.
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

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
  if (b.t === 'qr') return b.ancho + 8;
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
    } else if (b.t === 'qr') {
      const m = b.ancho / b.tam;
      const x0 = (ANCHO - b.ancho) / 2;
      doc.save().fillColor('#000');
      for (let r = 0; r < b.tam; r++)
        for (let c = 0; c < b.tam; c++) if (b.modulos[r * b.tam + c]) doc.rect(x0 + c * m, y + 4 + r * m, m, m);
      doc.fill().restore();
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
// Código QR: se guarda la matriz de módulos (la usan el PDF y la ticketera)
function qr(texto, ancho = 110) {
  const q = QRCode.create(texto, { errorCorrectionLevel: 'M' });
  return { t: 'qr', ancho, tam: q.modules.size, modulos: Array.from(q.modules.data, (v) => (v ? 1 : 0)) };
}

function lineasGuarnicion(it) {
  const r = it.sopa ? [{ txt: `+ Sopa: ${it.sopa}`, cambio: false }] : [];
  if (it.refresco) r.push({ txt: `+ Refresco: ${it.refresco}`, cambio: false });
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
  if (c.tipo === 'local') {
    b.push(centro(`MESA ${c.mesa_numero ?? '?'}`, 20, true));
    if (c.mesa_piso) b.push(centro(c.mesa_piso.toUpperCase(), 11, true));
  }
  else {
    b.push(centro('PARA LLEVAR', 18, true));
    if (c.cliente) b.push(centro(c.cliente, 13, true));
  }
  // en mesa: los platos para llevar van aparte, para empacarlos (el envase no es para cocina)
  const platos = c.items.filter((it) => it.tipo !== 'envase');
  const llevar = c.tipo === 'local' ? platos.filter((it) => it.para_llevar) : [];
  if (llevar.length) b.push(centro(`+ ${llevar.reduce((s, it) => s + it.cantidad, 0)} PARA LLEVAR`, 13, true));
  if (c.ticket_modificado) b.push(espacio(2), centro('*** COMANDA MODIFICADA ***', 11, true));
  b.push(centro(`${String(c.enviado_en || c.creado_en).slice(11, 16)} · ${c.mozo_nombre || ''}`, 10), linea());
  const plato = (it) => {
    b.push(texto(`${it.cantidad} x ${it.nombre}`, 14, { negrita: true, sep: 1 }));
    for (const g of lineasGuarnicion(it)) b.push(texto(g.txt, 12, { negrita: g.cambio, sep: 1, sangria: 18 }));
    if (it.nota) b.push(texto(`NOTA: ${it.nota}`, 12, { negrita: true, sep: 1, sangria: 18 }));
    b.push(espacio(5));
  };
  platos.filter((it) => !llevar.includes(it)).forEach(plato);
  if (llevar.length) {
    b.push(linea(), centro('*** PARA LLEVAR ***', 18, true), centro('empacar', 10), linea());
    llevar.forEach(plato);
  }
  if (c.nota) b.push(linea(), texto(`NOTA: ${c.nota}`, 13, { negrita: true }));
  b.push(linea(), centro(`Impreso ${momento}`, 8));
  return b;
}

/** Nota de venta (comprobante interno) para el cliente. Sin cobro = precuenta (antes de pagar). Boletas y facturas electrónicas: comprobanteSunat. */
function comprobante({ cobro, comandas, config, cajero, ahora }) {
  const dinero = (n) => `${config.moneda} ${Number(n || 0).toFixed(2)}`;
  const b = [LOGO ? imagen(LOGO, ANCHO_LOGO) : centro(config.nombreRestaurante, 14, true)];
  if (config.ruc) b.push(centro(`RUC ${config.ruc}`, 9));
  if (config.direccion) b.push(centro(config.direccion, 9));
  if (config.telefono) b.push(centro(`Tel. ${config.telefono}`, 9));
  const fecha = cobro?.creado_en || ahora;
  b.push(linea(), centro(cobro ? 'NOTA DE VENTA' : 'PRECUENTA', 11, true));
  if (cobro) b.push(centro(`N° ${String(cobro.id).padStart(6, '0')}`, 10));
  b.push(centro(`${fecha.slice(0, 10).split('-').reverse().join('/')}  ${fecha.slice(11, 16)}`, 9), linea());

  const primera = comandas[0];
  b.push(texto(primera.tipo === 'local' ? `Mesa: ${primera.mesa_numero}${primera.mesa_piso ? ` (${primera.mesa_piso})` : ''}` : `Para llevar${primera.cliente ? `: ${primera.cliente}` : ''}`, 10, { negrita: true }));
  const atenciones = [...new Set(comandas.map((c) => c.atencion_numero).filter(Boolean))];
  if (atenciones.length) b.push(texto(`Atención${atenciones.length > 1 ? 'es' : ''}: ${atenciones.map((n) => `#${n}`).join(', ')}`, 10, { negrita: true }));
  b.push(texto(`Comanda${comandas.length > 1 ? 's' : ''}:${comandas.map((c) => `#${c.numero_dia}`).join(', ')}`, 9));
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
  const total = cobro ? cobro.total : comandas.reduce((s, c) => s + c.total, 0);
  b.push(linea(), fila('TOTAL', dinero(total), 14, true), espacio(4));
  if (!cobro) return [...b, linea(), centro('Documento no válido como comprobante de pago', 8)];
  // pago mixto: una línea por forma de pago; el vuelto es sobre la parte en efectivo
  const pagos = cobro.pagos?.length ? cobro.pagos : [{ metodo: cobro.metodo, monto: cobro.total }];
  if (pagos.length > 1) {
    b.push(texto('Forma de pago', 10));
    for (const p of pagos) b.push(fila(`   ${p.metodo}`, dinero(p.monto), 10));
  } else b.push(fila('Forma de pago', pagos[0].metodo, 10));
  if (cobro.recibido != null) {
    const efectivo = pagos.filter((p) => p.metodo === 'Efectivo').reduce((s, p) => s + p.monto, 0);
    b.push(fila('Recibido', dinero(cobro.recibido), 10), fila('Vuelto', dinero(cobro.recibido - efectivo), 10, true));
  }
  if (cajero) b.push(texto(`Cobrado por: ${cajero}`, 8));
  b.push(linea());
  if (config.pieComprobante) b.push(centro(config.pieComprobante, 10, true));
  if (config.avisoComprobante) b.push(centro(config.avisoComprobante, 7));
  return b;
}

/** Representación impresa de una boleta o factura electrónica emitida en SUNAT (datos leídos del XML) */
function comprobanteSunat(d, config, qrTexto) {
  const simbolo = d.moneda === 'PEN' ? 'S/' : d.moneda === 'USD' ? 'US$' : d.moneda;
  const dinero = (n) => `${simbolo} ${Number(n || 0).toFixed(2)}`;
  const t = d.totales;
  const b = [];
  if (LOGO) b.push(imagen(LOGO, ANCHO_LOGO));
  b.push(centro(d.emisor.razonSocial || config.nombreRestaurante, 10, true));
  if (d.emisor.nombreComercial && d.emisor.nombreComercial !== d.emisor.razonSocial) b.push(centro(d.emisor.nombreComercial, 9));
  b.push(centro(`RUC ${d.emisor.ruc}`, 10, true));
  if (d.emisor.direccion) b.push(centro(d.emisor.direccion, 8));
  b.push(linea(), centro(d.tipoTexto, 11, true), centro(`${d.serie}-${d.numero}`, 14, true), linea());

  b.push(texto(`Fecha de emisión: ${d.fecha.split('-').reverse().join('/')}${d.hora ? `  ${d.hora.slice(0, 5)}` : ''}`, 9));
  const docCliente = d.cliente.doc && !/^-+$/.test(d.cliente.doc) ? d.cliente.doc : '';
  if (d.tipo === '01') {
    b.push(texto(`RUC: ${docCliente}`, 9), texto(`Razón social: ${d.cliente.nombre}`, 9));
    if (d.cliente.direccion) b.push(texto(`Dirección: ${d.cliente.direccion}`, 9));
  } else {
    if (docCliente) b.push(texto(`${d.cliente.tipoDocTexto || 'Doc.'}: ${docCliente}`, 9));
    if (d.cliente.nombre && !/^-+$/.test(d.cliente.nombre)) b.push(texto(`Cliente: ${d.cliente.nombre}`, 9));
  }
  if (d.formaPago) b.push(texto(`Forma de pago: ${d.formaPago}`, 9));
  b.push(linea(), fila('Cant. Descripción', 'Importe', 9, true), espacio(2));
  for (const it of d.items) {
    const cant = Number.isInteger(it.cantidad) ? it.cantidad : it.cantidad.toFixed(2);
    b.push(fila(`${cant} x ${it.descripcion}`, dinero(it.importe), 10));
    if (it.cantidad !== 1) b.push(texto(`P. unit. ${dinero(it.precioUnitario)}`, 8, { sangria: 14, sep: 3 }));
  }
  b.push(linea());
  const porcentaje = d.items.find((i) => i.porcentaje)?.porcentaje;
  if (t.gravada) b.push(fila('Op. gravada', dinero(t.gravada), 9));
  if (t.exonerada) b.push(fila('Op. exonerada', dinero(t.exonerada), 9));
  if (t.inafecta) b.push(fila('Op. inafecta', dinero(t.inafecta), 9));
  if (t.gratuita) b.push(fila('Op. gratuita', dinero(t.gratuita), 9));
  if (t.descuentos) b.push(fila('Descuentos', dinero(t.descuentos), 9));
  b.push(fila(`IGV${porcentaje ? ` (${porcentaje}%)` : ''}`, dinero(t.igv), 9));
  if (t.icbper) b.push(fila('ICBPER', dinero(t.icbper), 9));
  b.push(fila('IMPORTE TOTAL', dinero(t.total), 13, true), espacio(3));
  if (d.letras) b.push(texto(`SON: ${d.letras}`, 8));
  b.push(espacio(4), qr(qrTexto));
  if (d.hash) b.push(centro(`Resumen: ${d.hash}`, 7));
  b.push(centro(`Representación impresa de la ${d.tipoTexto.toLowerCase()}.`, 8));
  b.push(centro('Puede consultar su validez en www.sunat.gob.pe', 8));
  if (config.pieComprobante) b.push(linea(), centro(config.pieComprobante, 10, true));
  return b;
}

module.exports = { generarPDF, ticketCocina, comprobante, comprobanteSunat };
