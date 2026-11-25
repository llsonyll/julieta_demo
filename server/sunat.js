// Comprobantes electrónicos emitidos en SUNAT (SEE-SOL): lectura del XML (UBL 2.1) que se descarga
// de SOL, y registro del comprobante vinculado al cobro, para imprimir su representación.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { db } = require('./db');

const DIR = path.join(__dirname, '..', 'data', 'sunat');

db.exec(`
CREATE TABLE IF NOT EXISTS comprobantes_sunat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cobro_id INTEGER REFERENCES cobros(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL,            -- 01 factura, 03 boleta
  serie TEXT NOT NULL,
  numero TEXT NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL DEFAULT '',
  ruc_emisor TEXT NOT NULL DEFAULT '',
  cliente_tipo_doc TEXT NOT NULL DEFAULT '',
  cliente_doc TEXT NOT NULL DEFAULT '',
  cliente_nombre TEXT NOT NULL DEFAULT '',
  moneda TEXT NOT NULL DEFAULT 'PEN',
  igv REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  datos TEXT NOT NULL,           -- todo lo leído del XML (JSON)
  archivo TEXT NOT NULL,         -- XML original guardado en data/sunat/
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  subido_en TEXT NOT NULL,
  UNIQUE (ruc_emisor, tipo, serie, numero)
);
`);
// tipo de comprobante elegido al cobrar: 'nota' (nota de venta) o 'sunat' (boleta/factura en SOL)
if (!db.prepare('PRAGMA table_info(cobros)').all().some((c) => c.name === 'comprobante'))
  db.exec("ALTER TABLE cobros ADD COLUMN comprobante TEXT NOT NULL DEFAULT 'nota'");

const TIPOS = { '01': 'FACTURA ELECTRÓNICA', '03': 'BOLETA DE VENTA ELECTRÓNICA' };
const TIPOS_DOC = { 0: 'Doc.', 1: 'DNI', 4: 'C.E.', 6: 'RUC', 7: 'Pasaporte', A: 'Céd. diplomática' };

// ---------------- ZIP (por si SOL descarga el XML comprimido) ----------------
function xmlDeZip(buf) {
  // fin del directorio central
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      fin = i;
      break;
    }
  if (fin < 0) throw new Error('El ZIP está dañado');
  const entradas = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  for (let n = 0; n < entradas; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComent = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('utf8', p + 46, p + 46 + largoNombre);
    p += 46 + largoNombre + largoExtra + largoComent;
    if (!/\.xml$/i.test(nombre)) continue;
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tamComp);
    if (metodo === 0) return datos;
    if (metodo === 8) return zlib.inflateRawSync(datos);
    throw new Error('El ZIP usa una compresión no soportada');
  }
  throw new Error('El ZIP no contiene ningún archivo XML');
}

// ---------------- XML ----------------
const ENTIDADES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decodificar = (t) =>
  t.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTIDADES[e] ?? m
  );

/** Árbol simple: { nombre (sin prefijo), atributos, hijos, texto } */
function leerXML(texto) {
  const raiz = { nombre: '#doc', atributos: {}, hijos: [], texto: '' };
  const pila = [raiz];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^>\s]+)\s*>|<([^>\s/]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(texto))) {
    const actual = pila[pila.length - 1];
    if (m[1] !== undefined) actual.texto += m[1];
    else if (m[2]) {
      if (pila.length > 1) pila.pop();
    } else if (m[3]) {
      const atributos = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) atributos[a[1].replace(/^.*:/, '')] = decodificar(a[2] ?? a[3]);
      const nodo = { nombre: m[3].replace(/^.*:/, ''), atributos, hijos: [], texto: '' };
      actual.hijos.push(nodo);
      if (!m[5]) pila.push(nodo);
    } else if (m[6]) actual.texto += decodificar(m[6]);
  }
  return raiz.hijos.find((h) => h.nombre !== '#doc') || null;
}

const hijo = (n, nombre) => n?.hijos.find((h) => h.nombre === nombre) || null;
const hijos = (n, nombre) => n?.hijos.filter((h) => h.nombre === nombre) || [];
/** Sigue una ruta de hijos directos: 'A/B/C' */
const ruta = (n, r) => r.split('/').reduce((x, p) => hijo(x, p), n);
const txt = (n, r) => (r ? ruta(n, r) : n)?.texto.trim() || '';
const num = (n, r) => {
  const v = parseFloat(txt(n, r));
  return Number.isFinite(v) ? v : 0;
};
function buscar(n, nombre) {
  if (!n) return null;
  if (n.nombre === nombre) return n;
  for (const h of n.hijos) {
    const r = buscar(h, nombre);
    if (r) return r;
  }
  return null;
}
const redondear = (v) => Math.round(v * 100) / 100;

/** Lee un comprobante (boleta o factura) en UBL 2.1. Lanza Error con un mensaje claro si no lo es. */
/** El XML tal cual (si viene en ZIP, el que está adentro) */
function extraerXML(contenido) {
  const buf = Buffer.isBuffer(contenido) ? contenido : Buffer.from(contenido);
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50 ? xmlDeZip(buf) : buf;
}

function leerComprobante(contenido) {
  const texto = extraerXML(contenido).toString('utf8').replace(/^\uFEFF/, '');
  const raiz = leerXML(texto);
  if (!raiz) throw new Error('El archivo no es un XML válido');
  if (raiz.nombre === 'CreditNote' || raiz.nombre === 'DebitNote') throw new Error('Es una nota de crédito o débito: por ahora solo se imprimen boletas y facturas');
  if (raiz.nombre !== 'Invoice') throw new Error('El XML no es una boleta ni una factura electrónica');

  const tipo = txt(raiz, 'InvoiceTypeCode');
  if (!TIPOS[tipo]) throw new Error(`Tipo de comprobante no soportado (${tipo || 'sin tipo'})`);
  const id = txt(raiz, 'ID');
  const [serie, numero] = id.includes('-') ? [id.slice(0, id.lastIndexOf('-')), id.slice(id.lastIndexOf('-') + 1)] : [id, ''];
  if (!serie || !numero) throw new Error('El XML no tiene serie y número');

  const emisor = ruta(raiz, 'AccountingSupplierParty/Party');
  const dirEmisor = ruta(emisor, 'PartyLegalEntity/RegistrationAddress');
  const cliente = ruta(raiz, 'AccountingCustomerParty/Party');
  const idCliente = ruta(cliente, 'PartyIdentification/ID');
  const dirCliente = ruta(cliente, 'PartyLegalEntity/RegistrationAddress');

  // impuestos del comprobante (TaxTotal directo de la raíz, no los de cada línea)
  const totalesImp = { gravada: 0, exonerada: 0, inafecta: 0, gratuita: 0, icbper: 0, isc: 0 };
  const taxTotal = hijo(raiz, 'TaxTotal');
  for (const sub of hijos(taxTotal, 'TaxSubtotal')) {
    const codigo = txt(sub, 'TaxCategory/TaxScheme/ID');
    if (codigo === '1000') totalesImp.gravada += num(sub, 'TaxableAmount');
    else if (codigo === '9997') totalesImp.exonerada += num(sub, 'TaxableAmount');
    else if (codigo === '9998') totalesImp.inafecta += num(sub, 'TaxableAmount');
    else if (codigo === '9996') totalesImp.gratuita += num(sub, 'TaxableAmount');
    else if (codigo === '7152') totalesImp.icbper += num(sub, 'TaxAmount');
    else if (codigo === '2000') totalesImp.isc += num(sub, 'TaxAmount');
  }
  const igv = hijos(taxTotal, 'TaxSubtotal')
    .filter((s) => txt(s, 'TaxCategory/TaxScheme/ID') === '1000')
    .reduce((s, x) => s + num(x, 'TaxAmount'), 0);

  const items = hijos(raiz, 'InvoiceLine').map((l) => {
    const cantidad = num(l, 'InvoicedQuantity');
    const valorUnitario = num(l, 'Price/PriceAmount');
    const ref = hijos(hijo(l, 'PricingReference'), 'AlternativeConditionPrice').find((a) => txt(a, 'PriceTypeCode') === '01');
    const precioUnitario = ref ? num(ref, 'PriceAmount') : 0;
    const valorVenta = num(l, 'LineExtensionAmount');
    const igvLinea = num(l, 'TaxTotal/TaxAmount');
    const porcentaje = num(ruta(l, 'TaxTotal/TaxSubtotal/TaxCategory'), 'Percent');
    return {
      cantidad,
      unidad: ruta(l, 'InvoicedQuantity')?.atributos.unitCode || 'NIU',
      descripcion: hijos(hijo(l, 'Item'), 'Description').map((d) => d.texto.trim()).filter(Boolean).join(' ') || txt(l, 'Item/Name'),
      valorUnitario,
      precioUnitario: precioUnitario || (cantidad ? redondear((valorVenta + igvLinea) / cantidad) : 0),
      valorVenta,
      igv: igvLinea,
      porcentaje,
      importe: precioUnitario ? redondear(precioUnitario * cantidad) : redondear(valorVenta + igvLinea),
    };
  });
  if (!items.length) throw new Error('El comprobante no tiene detalle');

  const total = num(raiz, 'LegalMonetaryTotal/PayableAmount');
  const notas = hijos(raiz, 'Note');
  const letras = (notas.find((n) => n.atributos.languageLocaleID === '1000') || notas[0])?.texto.trim() || '';
  const formaPago = hijos(raiz, 'PaymentTerms').find((p) => txt(p, 'ID') === 'FormaPago');

  return {
    tipo,
    tipoTexto: TIPOS[tipo],
    serie,
    numero,
    fecha: txt(raiz, 'IssueDate'),
    hora: txt(raiz, 'IssueTime').slice(0, 8),
    moneda: txt(raiz, 'DocumentCurrencyCode') || 'PEN',
    emisor: {
      ruc: txt(emisor, 'PartyIdentification/ID') || txt(raiz, 'AccountingSupplierParty/CustomerAssignedAccountID'),
      razonSocial: txt(emisor, 'PartyLegalEntity/RegistrationName'),
      nombreComercial: txt(emisor, 'PartyName/Name'),
      direccion: [txt(dirEmisor, 'AddressLine/Line'), txt(dirEmisor, 'District'), txt(dirEmisor, 'CityName'), txt(dirEmisor, 'CountrySubentity')]
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(' - '),
    },
    cliente: {
      tipoDoc: idCliente?.atributos.schemeID ?? '',
      tipoDocTexto: TIPOS_DOC[idCliente?.atributos.schemeID] || '',
      doc: idCliente?.texto.trim() || '',
      nombre: txt(cliente, 'PartyLegalEntity/RegistrationName'),
      direccion: txt(dirCliente, 'AddressLine/Line'),
    },
    items,
    totales: {
      ...Object.fromEntries(Object.entries(totalesImp).map(([k, v]) => [k, redondear(v)])),
      igv: redondear(igv || num(taxTotal, 'TaxAmount')),
      descuentos: num(raiz, 'LegalMonetaryTotal/AllowanceTotalAmount'),
      total,
    },
    letras,
    formaPago: formaPago ? txt(formaPago, 'PaymentMeansID') : '',
    hash: buscar(raiz, 'DigestValue')?.texto.trim() || '',
  };
}

/** Texto del QR según el formato de SUNAT para representaciones impresas */
function textoQR(d) {
  return [
    d.emisor.ruc,
    d.tipo,
    d.serie,
    d.numero,
    d.totales.igv.toFixed(2),
    d.totales.total.toFixed(2),
    d.fecha,
    d.cliente.tipoDoc,
    d.cliente.doc,
    d.hash,
    '',
  ].join('|');
}

// ---------------- registro ----------------
const COLS = `c.id, c.cobro_id, c.tipo, c.serie, c.numero, c.fecha, c.hora, c.ruc_emisor, c.cliente_tipo_doc, c.cliente_doc,
  c.cliente_nombre, c.moneda, c.igv, c.total, c.subido_en`;

/** Guarda el comprobante (y su XML). Si ya existía el mismo número, lo devuelve sin duplicarlo. */
function registrar(d, xml, usuarioId, ahora) {
  const previo = db
    .prepare(`SELECT ${COLS} FROM comprobantes_sunat c WHERE ruc_emisor = ? AND tipo = ? AND serie = ? AND numero = ?`)
    .get(d.emisor.ruc, d.tipo, d.serie, d.numero);
  if (previo) return { comprobante: previo, repetido: true };
  fs.mkdirSync(DIR, { recursive: true });
  const archivo = `${d.emisor.ruc || 'sin-ruc'}-${d.tipo}-${d.serie}-${d.numero}.xml`.replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(DIR, archivo), xml);
  const id = db
    .prepare(
      `INSERT INTO comprobantes_sunat (tipo, serie, numero, fecha, hora, ruc_emisor, cliente_tipo_doc, cliente_doc, cliente_nombre,
         moneda, igv, total, datos, archivo, usuario_id, subido_en) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(d.tipo, d.serie, d.numero, d.fecha, d.hora, d.emisor.ruc, d.cliente.tipoDoc, d.cliente.doc, d.cliente.nombre, d.moneda,
      d.totales.igv, d.totales.total, JSON.stringify(d), archivo, usuarioId, ahora).lastInsertRowid;
  return { comprobante: obtener(id), repetido: false };
}

const obtener = (id) => db.prepare(`SELECT ${COLS} FROM comprobantes_sunat c WHERE c.id = ?`).get(id) || null;
const datos = (id) => {
  const f = db.prepare('SELECT datos FROM comprobantes_sunat WHERE id = ?').get(id);
  return f ? JSON.parse(f.datos) : null;
};
const rutaXML = (id) => {
  const f = db.prepare('SELECT archivo FROM comprobantes_sunat WHERE id = ?').get(id);
  return f ? path.join(DIR, f.archivo) : null;
};

/** Cobros "boleta/factura SUNAT" sin XML todavía, que podrían corresponder a este comprobante */
function candidatos(d) {
  return db
    .prepare(
      `SELECT co.* FROM cobros co
       WHERE co.anulado = 0 AND co.comprobante = 'sunat'
         AND NOT EXISTS (SELECT 1 FROM comprobantes_sunat s WHERE s.cobro_id = co.id)
         AND ABS(co.total - ?) < 0.01 AND co.fecha BETWEEN date(?, '-1 day') AND date(?, '+1 day')
       ORDER BY ABS(julianday(co.fecha) - julianday(?)), co.id DESC`
    )
    .all(d.totales.total, d.fecha, d.fecha, d.fecha);
}

function vincular(id, cobroId) {
  db.prepare('UPDATE comprobantes_sunat SET cobro_id = ? WHERE id = ?').run(cobroId || null, id);
  if (cobroId) db.prepare("UPDATE cobros SET comprobante = 'sunat' WHERE id = ?").run(cobroId);
  return obtener(id);
}

function eliminar(id) {
  const f = rutaXML(id);
  db.prepare('DELETE FROM comprobantes_sunat WHERE id = ?').run(id);
  if (f) fs.rmSync(f, { force: true });
}

module.exports = { extraerXML, leerComprobante, textoQR, registrar, obtener, datos, rutaXML, candidatos, vincular, eliminar, TIPOS };
