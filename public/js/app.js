'use strict';
/* =========================================================
   Comandas - cliente web (mobile first, sin dependencias)
   ========================================================= */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  me: null,
  config: { moneda: 'S/', nombreRestaurante: 'Comandas', metodosPago: ['Efectivo'] },
  desfase: 0, // diferencia de reloj entre servidor y celular (ms)
  sse: null,
  vista: null, // { nombre, recargar, escucha: [] }
  timers: [],
  filtroComandas: 'activas',
  adminTab: 'carta',
  filtroPlatos: 'todos',
  filtroCarta: 'todas',
  fechaCarta: null,
  fechaReporte: null,
  audio: null,
  ticketera: { activa: false, caja: false, autoComandas: false, pendientes: 0, errores: 0 },
};

const EN_COCINA = ['enviado_cocina', 'en_proceso', 'esperando_entrega'];
const ESTADO_TXT = {
  generado: 'Generado',
  enviado_cocina: 'En cocina',
  en_proceso: 'En cocina',
  esperando_entrega: 'En cocina',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const claseEstado = (e) => (EN_COCINA.includes(e) ? 'enviado_cocina' : e);
const ROL_TXT = { admin: 'Administrador', mozo: 'Mozo', caja: 'Caja', cocina: 'Cocina' };
const TABS = {
  admin: ['mesas', 'comandas', 'tickets', 'comprobantes', 'carta', 'reporte', 'admin'],
  mozo: ['mesas', 'comandas', 'carta'],
  caja: ['mesas', 'comandas', 'tickets', 'comprobantes', 'reporte'],
  cocina: ['tickets', 'carta'],
};
// [texto, grupo, icono (trazos SVG estilo lucide)]
const TAB_INFO = {
  mesas: ['Salón', 'Operaciones', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'],
  comandas: ['Pedidos / Comandas', 'Operaciones', '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'],
  tickets: ['Cocina', 'Operaciones', '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.46.32-.84.73-1.04a4 4 0 0 0-2.14-7.59 5 5 0 0 0-9.18 0 4 4 0 0 0-2.14 7.59c.41.2.73.58.73 1.04V20a1 1 0 0 0 1 1ZM6 17h12"/>'],
  comprobantes: ['Comprobantes SUNAT', 'Operaciones', '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15l2 2 4-4"/>'],
  carta: ['Cartas', 'Catálogos', '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'],
  reporte: ['Reportes', 'Análisis', '<path d="M3 3v18h18M8 17V9M13 17V5M18 17v-3"/>'],
  admin: ['Configuración', 'Sistema', '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'],
};
// Tabs disponibles según todos los roles del usuario (unión ordenada)
function tabsDelUsuario() {
  const roles = S.me?.roles || [S.me?.rol];
  const orden = ['mesas', 'comandas', 'tickets', 'comprobantes', 'carta', 'reporte', 'admin'];
  const todos = new Set(roles.flatMap((r) => TABS[r] || []));
  return orden.filter((t) => todos.has(t));
}

const svg = (d, t = 20) =>
  `<svg width="${t}" height="${t}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const dinero = (n) => `${S.config.moneda} ${Number(n || 0).toFixed(2)}`;
const hora = (s) => (s ? String(s).slice(11, 16) : '');
const parseFecha = (s) => new Date(String(s).replace(' ', 'T'));
const ahoraServidor = () => Date.now() + S.desfase;
const minutosDesde = (s) => (s ? Math.max(0, Math.floor((ahoraServidor() - parseFecha(s).getTime()) / 60000)) : 0);
function fechaISO(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
const fechaHoy = () => fechaISO(new Date(ahoraServidor()));
const diaAnterior = (f) => fechaISO(new Date(parseFecha(`${f} 12:00:00`).getTime() - 86400000));
const puede = (...roles) => S.me && (S.me.roles || [S.me.rol]).some((r) => roles.includes(r));
// solo cocina (sin otro rol): ve la cola de cocina, no atenciones ni cobros
const soloCocina = () => !puede('admin', 'mozo', 'caja');
const tactil = () => matchMedia('(pointer: coarse)').matches;

// ---------------- API ----------------
async function api(metodo, url, cuerpo) {
  const r = await fetch(url, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    credentials: 'same-origin',
  });
  let datos = null;
  try {
    datos = await r.json();
  } catch {}
  if (r.status === 401 && url !== '/api/login') {
    S.me = null;
    cerrarSSE();
    renderLogin('Su sesión terminó. Ingrese nuevamente.');
    throw new Error('Sesión expirada');
  }
  if (!r.ok) throw new Error(datos?.error || `Error ${r.status}`);
  return datos;
}

// ---------------- impresión de PDF ----------------
// En Chrome/Edge de escritorio se abre directamente el diálogo de impresión.
// En otros navegadores (Safari, celulares) el PDF se abre en una pestaña nueva para imprimirlo.
const imprimeDirecto = () => !!window.chrome && !tactil();
function prepararVentana() {
  return imprimeDirecto() ? null : window.open('', '_blank');
}
function imprimirPDF(url, ventana) {
  if (imprimeDirecto()) {
    $('#marco-impresion')?.remove();
    const f = document.createElement('iframe');
    f.id = 'marco-impresion';
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
    f.onload = () => {
      try {
        f.contentWindow.focus();
        f.contentWindow.print();
      } catch {
        window.open(url, '_blank');
      }
    };
    f.src = url;
    document.body.appendChild(f);
    return true;
  }
  if (ventana && !ventana.closed) {
    ventana.location.href = url;
    return true;
  }
  return !!window.open(url, '_blank');
}

// ---------------- ticketera térmica ----------------
// Con ticketera configurada (Gestión → Impresora), los tickets, precuentas y comprobantes
// los imprime el servidor directo en la impresora; sin ella, se usan los PDF de siempre.
const usaTicketeraCaja = () => !!S.ticketera?.caja;

async function cargarTicketera() {
  try {
    actualizarTicketera(await api('GET', '/api/impresora/estado'), false);
  } catch {}
}

function actualizarTicketera(d, avisar = true) {
  const antes = S.ticketera || {};
  S.ticketera = d;
  const el = $('#estado-impresora');
  if (el) {
    el.classList.toggle('oculto', !d.activa);
    el.classList.toggle('falla', d.errores > 0);
    el.title = !d.activa ? '' : d.errores > 0 ? `Ticketera sin respuesta: ${d.ultimoError}` : d.pendientes ? `Ticketera: ${d.pendientes} en cola` : 'Ticketera lista';
    const n = $('.contador', el);
    if (n) {
      n.textContent = d.pendientes + d.errores;
      n.classList.toggle('oculto', !(d.pendientes + d.errores));
    }
  }
  // aviso cuando la impresora deja de responder (una vez, no en cada reintento)
  if (avisar && d.errores > 0 && !(antes.errores > 0) && ['admin', 'caja', 'cocina'].includes(S.me?.rol)) {
    sonar(2);
    toast(`⚠️ La ticketera no responde: ${d.ultimoError || 'revise que esté encendida'}. Se reintentará sola.`, 'error', 8000);
  }
  if (avisar && antes.errores > 0 && !d.errores) toast('🖨️ Ticketera conectada de nuevo', 'ok');
  if (avisar && ['tickets', 'admin'].includes(S.vista?.nombre)) {
    clearTimeout(recargaPendiente);
    recargaPendiente = setTimeout(recargarVista, 250);
  }
}

/** Manda algo a la ticketera y avisa el resultado */
async function aTicketera(url, cuerpo, mensaje) {
  try {
    await api('POST', url, cuerpo);
    toast(`🖨️ ${mensaje}`, 'ok', 2200);
    return true;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

// ---------------- avisos ----------------
function toast(msg, tipo = '', ms = 3000) {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  t.onclick = () => t.remove();
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
function desbloquearAudio() {
  try {
    if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (S.audio.state === 'suspended') S.audio.resume();
  } catch {}
}
function sonar(veces = 2) {
  try {
    if (S.audio) {
      for (let i = 0; i < veces; i++) {
        const o = S.audio.createOscillator();
        const g = S.audio.createGain();
        o.type = 'sine';
        o.frequency.value = 880;
        const t0 = S.audio.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
        o.connect(g).connect(S.audio.destination);
        o.start(t0);
        o.stop(t0 + 0.32);
      }
    }
  } catch {}
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
}

// ---------------- modal ----------------
function abrirModal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="caja">${html}</div>`;
  m.classList.remove('oculto');
  m.ondragover = m.ondragleave = m.ondrop = null; // la ventana de cobro los usa para soltar el XML
  m.onclick = (e) => {
    if (e.target === m) cerrarModal();
  };
  const primero = $('input:not([type=checkbox]), select, textarea', m);
  if (primero && !tactil()) primero.focus();
  return m;
}
function cerrarModal() {
  const m = $('#modal');
  m.classList.add('oculto');
  m.innerHTML = '';
}

function confirmar(mensaje, { ok = 'Confirmar', peligro = false } = {}) {
  return new Promise((resolve) => {
    const m = abrirModal(`
      <div class="pila">
        <h3>${esc(mensaje)}</h3>
        <div class="fila"><button class="btn crecer" data-r="0">Volver</button>
        <button class="btn crecer ${peligro ? 'peligro' : 'primario'}" data-r="1">${esc(ok)}</button></div>
      </div>`);
    $$('[data-r]', m).forEach((b) => (b.onclick = () => (cerrarModal(), resolve(b.dataset.r === '1'))));
  });
}

/**
 * Formulario genérico en modal.
 * campos: [{ n, l, t: text|number|password|select|check|textarea|date, op: [[valor, texto]], req, ayuda, paso, lista, attrs }]
 */
function formulario({ titulo, campos, valores = {}, enviar, eliminar, textoEliminar = 'Eliminar' }) {
  const html = campos
    .map((c) => {
      const v = valores[c.n] ?? c.def ?? '';
      if (c.t === 'check')
        return `<label class="check"><input type="checkbox" name="${c.n}" ${v ? 'checked' : ''}> ${esc(c.l)}</label>
          ${c.ayuda ? `<small class="suave ayuda-check">${esc(c.ayuda)}</small>` : ''}`;
      if (c.t === 'checks') {
        const vals = Array.isArray(v) ? v.map(String) : [];
        return `<label class="campo"><span>${esc(c.l)}</span><div data-checks="${c.n}">${c.op
          .map(([ov, ot]) => `<label class="check"><input type="checkbox" value="${esc(ov)}" ${vals.includes(String(ov)) ? 'checked' : ''}> ${esc(ot)}</label>`)
          .join('')}</div></label>`;
      }
      let control;
      if (c.t === 'select')
        control = `<select name="${c.n}">${c.op
          .map(([ov, ot]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ot)}</option>`)
          .join('')}</select>`;
      else if (c.t === 'textarea') control = `<textarea name="${c.n}">${esc(v)}</textarea>`;
      else
        control = `<input name="${c.n}" type="${c.t || 'text'}" value="${esc(v)}" ${c.lista ? `list="dl-${c.n}"` : ''}
          ${c.t === 'number' ? `step="${c.paso || 'any'}" min="0" inputmode="decimal"` : ''} ${c.attrs || ''} autocomplete="off">
          ${c.lista ? `<datalist id="dl-${c.n}">${c.lista.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>` : ''}`;
      return `<label class="campo"><span>${esc(c.l)}</span>${control}${c.ayuda ? `<small class="suave">${esc(c.ayuda)}</small>` : ''}</label>`;
    })
    .join('');
  const m = abrirModal(`
    <form class="pila" novalidate>
      <div class="fila entre"><h3>${esc(titulo)}</h3><button type="button" class="btn chico" data-x>✕</button></div>
      ${html}
      <div class="error" data-err></div>
      <div class="fila">
        ${eliminar ? `<button type="button" class="btn peligro" data-del>${esc(textoEliminar)}</button>` : ''}
        <button class="btn primario crecer">Guardar</button>
      </div>
    </form>`);
  const f = $('form', m);
  $('[data-x]', m).onclick = cerrarModal;
  const err = $('[data-err]', m);
  if (eliminar)
    $('[data-del]', m).onclick = async () => {
      if (!(await confirmar('¿Eliminar este registro?', { ok: 'Eliminar', peligro: true }))) return;
      try {
        await eliminar();
        recargarVista();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const datos = {};
    for (const c of campos) {
      if (c.t === 'checks') {
        datos[c.n] = [...f.querySelectorAll(`[data-checks="${c.n}"] input:checked`)].map((cb) => cb.value);
      } else {
        const el = f.elements[c.n];
        if (c.t === 'check') datos[c.n] = el.checked;
        else if (c.t === 'number') datos[c.n] = el.value === '' ? '' : Number(el.value);
        else datos[c.n] = el.value;
        if (c.req && (datos[c.n] === '' || datos[c.n] == null)) {
          err.textContent = `Complete: ${c.l}`;
          return;
        }
      }
    }
    const btn = $('button.primario', f);
    btn.disabled = true;
    try {
      await enviar(datos);
      cerrarModal();
      toast('Guardado', 'ok');
      recargarVista();
    } catch (e2) {
      err.textContent = e2.message;
      btn.disabled = false;
    }
  };
  return f;
}

// ---------------- tiempo real ----------------
function cerrarSSE() {
  if (S.sse) S.sse.close();
  S.sse = null;
  setVivo(false);
}
function setVivo(v) {
  const p = $('#punto');
  if (p) {
    p.classList.toggle('vivo', v);
    p.title = v ? 'Conectado en tiempo real' : 'Reconectando…';
  }
}
function abrirSSE() {
  cerrarSSE();
  const es = new EventSource('/api/eventos');
  S.sse = es;
  es.onopen = () => setVivo(true);
  es.onerror = () => {
    setVivo(false);
    if (es.readyState === EventSource.CLOSED) {
      setTimeout(() => {
        if (S.me && S.sse === es) api('GET', '/api/me').then(abrirSSE).catch(() => {});
      }, 4000);
    }
  };
  for (const ev of ['comandas', 'mesas', 'productos', 'turnos', 'impresora']) {
    es.addEventListener(ev, (e) => {
      let d = {};
      try {
        d = JSON.parse(e.data || '{}');
      } catch {}
      alEvento(ev, d);
    });
  }
}

let recargaPendiente = null;
function alEvento(ev, d) {
  if (ev === 'impresora') return actualizarTicketera(d);
  if (ev === 'comandas') {
    notificar(d);
    actualizarContadores();
  }
  if (S.vista?.escucha?.includes(ev)) {
    clearTimeout(recargaPendiente);
    recargaPendiente = setTimeout(recargarVista, 250);
  }
}

// Aviso de ticket nuevo para la estación de impresión
function notificar(d) {
  if (!S.me || d.accion === 'eliminada' || d.accion === 'impreso') return;
  const nuevoTicket = d.estado === 'enviado_cocina' && !d.ticket_impreso && ['creada', 'estado', 'editada'].includes(d.accion);
  if (!nuevoTicket) return;
  const enTickets = S.vista?.nombre === 'tickets';
  if (puede('cocina', 'caja') || (puede('admin') && enTickets)) {
    const donde = d.tipo === 'llevar' ? 'para llevar' : `mesa ${d.mesa}`;
    // con la ticketera imprimiendo sola, solo se informa (sin alarma)
    if (S.ticketera?.autoComandas) return toast(`🖨️ Comanda #${d.numero} (${donde}) enviada a la ticketera`, 'aviso', 3500);
    sonar(3);
    toast(`🖨️ Ticket ${d.accion === 'editada' ? 'modificado' : 'nuevo'} #${d.numero} (${donde})`, 'aviso', 5000);
  }
}

async function actualizarContadores() {
  if (!S.me || !tabsDelUsuario().includes('tickets')) return;
  try {
    const lista = await api('GET', '/api/comandas?vista=cocina');
    const n = lista.filter((c) => !c.ticket_impreso).length;
    $$('.contador').forEach((el) => {
      el.textContent = n;
      el.classList.toggle('oculto', !n);
    });
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  if (!S.sse || S.sse.readyState === EventSource.CLOSED) abrirSSE();
  recargarVista();
  actualizarContadores();
});

// ---------------- dirección para los celulares ----------------
/** Direcciones de la PC servidor; primero la que se está usando, si se entró desde la red */
function direccionesCelular() {
  const d = S.config.direcciones || [];
  const actual = d.find((x) => x.ip === location.hostname);
  return actual ? [actual, ...d.filter((x) => x !== actual)] : d;
}
const direccionCelular = () => direccionesCelular()[0]?.url || '';

/** Ventana con la dirección y su QR para abrir el sistema desde un celular */
async function mostrarDireccion() {
  try {
    S.config.direcciones = (await api('GET', '/api/config')).direcciones; // por si cambió la IP
  } catch {}
  const d = direccionesCelular();
  if (!d.length) return toast('Esta PC no está conectada a ninguna red: revise el WiFi o el cable de red.', 'error', 6000);
  const p = d[0];
  const m = abrirModal(`
    <div class="pila direccion-red">
      <div class="fila entre"><h3>📱 Entrar desde el celular</h3><button class="btn chico" data-x>✕</button></div>
      <img class="qr-red" src="/api/red/qr.svg?u=${encodeURIComponent(p.url)}" alt="Código QR con la dirección ${esc(p.url)}" width="240" height="240">
      <div class="url-red">${esc(p.url)}</div>
      <ol class="pasos-red suave">
        <li>Conecte el celular al <b>WiFi del local</b>.</li>
        <li>Escanee el código con la cámara o escriba la dirección en el navegador.</li>
        <li>Use "Agregar a pantalla de inicio" para tenerlo como una app.</li>
      </ol>
      ${d.length > 1 ? `<div class="suave peq">Otras direcciones de esta PC: ${d.slice(1).map((x) => `${esc(x.url)} (${esc(x.interfaz)})`).join(' · ')}</div>` : ''}
      <button class="btn bloque" data-copiar="${esc(p.url)}">Copiar dirección</button>
    </div>`);
  $('[data-x]', m).onclick = cerrarModal;
  $('[data-copiar]', m).onclick = () => copiar(p.url);
}

// ---------------- login y estructura ----------------
const iniciales = (n) => String(n).trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const COLORES_AVATAR = ['#7c3aed', '#0d9488', '#db2777', '#d97706', '#2563eb', '#ea580c', '#16a34a', '#9333ea'];

async function renderLogin(mensaje = '') {
  cerrarModal();
  let usuarios = [];
  try {
    usuarios = await api('GET', '/api/login/usuarios');
  } catch (e) {
    mensaje = e.message;
  }
  let sel = null;
  let pin = '';
  let ocupado = false;
  $('#app').innerHTML = `
    <div class="login">
      <div class="login-marca">
        <h1 class="logo-placa"><img src="/logo.svg" alt="${esc(S.config.nombreRestaurante)}"></h1>
        <div>Sistema de comandas</div>
      </div>
      <div class="login-caja">
        <div class="login-usuarios">
          <h3>¿Quién eres?</h3>
          <div class="usuarios-grid">${usuarios
            .map(
              (u) => `<button type="button" class="usuario-btn" data-id="${u.id}">
                <span class="avatar" style="background:${COLORES_AVATAR[u.id % COLORES_AVATAR.length]}">${esc(iniciales(u.nombre))}</span>
                <b>${esc(u.nombre)}</b><small>${ROL_TXT[u.rol]}</small></button>`
            )
            .join('')}</div>
        </div>
        <div class="login-pin">
          <div class="suave" id="pin-titulo">Selecciona un usuario</div>
          <div class="pin-puntos" aria-hidden="true">${'<i></i>'.repeat(4)}</div>
          <div class="error" id="pin-error" role="alert">${esc(mensaje)}</div>
          <div class="teclado">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫']
            .map((k) => (k === '' ? '<span></span>' : `<button type="button" data-k="${k}" disabled aria-label="${k === '⌫' ? 'Borrar' : k}">${k}</button>`))
            .join('')}</div>
        </div>
      </div>
      ${
        direccionCelular()
          ? `<div class="login-red">📱 Para entrar desde los celulares: <b>${esc(direccionCelular())}</b>
              <button type="button" class="btn chico" id="ver-direccion">Ver QR</button></div>`
          : ''
      }
    </div>`;
  const vd = $('#ver-direccion');
  if (vd) vd.onclick = mostrarDireccion;

  const pintar = () => $$('.pin-puntos i').forEach((el, i) => el.classList.toggle('lleno', i < pin.length));
  const tecla = async (k) => {
    if (!sel || ocupado) return;
    $('#pin-error').textContent = '';
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (pin.length < 4) pin += k;
    pintar();
    if (pin.length < 4) return;
    ocupado = true;
    desbloquearAudio();
    try {
      S.me = await api('POST', '/api/login', { id: sel.id, pin });
      document.removeEventListener('keydown', teclaFisica);
      iniciarApp();
    } catch (err) {
      $('#pin-error').textContent = err.message;
      pin = '';
      pintar();
    } finally {
      ocupado = false;
    }
  };
  // Teclado físico (PC de caja): dígitos y retroceso
  const teclaFisica = (e) => {
    if (!$('.login')) return document.removeEventListener('keydown', teclaFisica);
    if (/^\d$/.test(e.key)) tecla(e.key);
    else if (e.key === 'Backspace') tecla('⌫');
  };
  document.addEventListener('keydown', teclaFisica);

  $$('.usuario-btn').forEach(
    (b) =>
      (b.onclick = () => {
        sel = usuarios.find((u) => u.id === Number(b.dataset.id));
        pin = '';
        pintar();
        $$('.usuario-btn').forEach((x) => x.classList.toggle('activo', x === b));
        $$('.teclado button').forEach((x) => (x.disabled = false));
        $('#pin-titulo').textContent = `Hola ${sel.nombre}, ingresa tu PIN`;
        $('#pin-error').textContent = '';
        $('.login-pin').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
  );
  $$('.teclado button').forEach((b) => (b.onclick = () => tecla(b.dataset.k)));
}

function renderShell() {
  const rol = S.me.rol;
  const grupos = {};
  for (const id of tabsDelUsuario()) (grupos[TAB_INFO[id][1]] ||= []).push(id);
  let colapsado = false;
  try {
    colapsado = localStorage.getItem('lateral') === 'colapsado';
  } catch {}
  $('#app').innerHTML = `
    <div class="app${colapsado ? ' colapsado' : ''}">
      <aside class="lateral">
        <div class="marca">
          <img class="logo" src="/icono.svg" alt="">
          <div class="txt"><b>${esc(S.config.nombreRestaurante)}</b><small>${esc(S.config.direccion || 'Sistema de comandas')}</small></div>
        </div>
        <div class="rol-pill"><span class="txt">${(S.me.roles || [rol]).map((r) => ROL_TXT[r]).join(' + ')}</span><span class="punto" id="punto"></span></div>
        <nav class="nav">${Object.entries(grupos)
          .map(
            ([g, ids]) => `<div class="grupo">${esc(g)}</div>${ids
              .map((id) => `<a href="#/${id}" data-tab="${id}" title="${esc(TAB_INFO[id][0])}">${svg(TAB_INFO[id][2])}<span class="txt">${esc(TAB_INFO[id][0])}</span>${id === 'tickets' ? '<span class="contador oculto"></span>' : ''}</a>`)
              .join('')}`
          )
          .join('')}</nav>
        <button class="colapsar" data-accion="colapsar">${svg('<path d="m15 18-6-6 6-6"/>', 16)}<span class="txt">Colapsar</span></button>
      </aside>
      <div class="velo" data-accion="menu-movil"></div>
      <div class="cuerpo">
        <header class="barra-sup">
          <button class="btn-menu" data-accion="menu-movil" aria-label="Menú">${svg('<path d="M4 6h16M4 12h16M4 18h16"/>', 22)}</button>
          <h1 id="titulo-vista" class="crecer"></h1>
          <span class="reloj" id="reloj"></span>
          ${tabsDelUsuario().includes('tickets') ? `<a class="impresora-sup oculto" id="estado-impresora" href="#/tickets" aria-label="Estado de la ticketera">${svg('<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>')}<span class="contador oculto"></span></a>` : ''}
          ${tabsDelUsuario().includes('tickets') ? `<a class="campana" href="#/tickets" aria-label="Tickets pendientes">${svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>')}<span class="contador oculto"></span></a>` : ''}
          <button class="usuario-sup" data-accion="menu-usuario" aria-label="Menú de usuario">
            <span class="avatar" style="background:${COLORES_AVATAR[S.me.id % COLORES_AVATAR.length]}">${esc(iniciales(S.me.nombre))}</span>
            <span class="txt"><b>${esc(S.me.nombre)}</b><small>${ROL_TXT[rol]}</small></span>
            ${svg('<path d="m6 9 6 6 6-6"/>', 16)}
          </button>
        </header>
        <main id="vista"></main>
      </div>
    </div>`;
  clearInterval(S.reloj);
  const tic = () => {
    const el = $('#reloj');
    if (el) el.textContent = new Date(ahoraServidor()).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  };
  tic();
  S.reloj = setInterval(tic, 10000);
}

function iniciarApp() {
  renderShell();
  abrirSSE();
  if (!location.hash || location.hash === '#/') location.hash = `#/${tabsDelUsuario()[0]}`;
  else navegar();
  actualizarContadores();
  cargarTicketera();
}

// ---------------- enrutador ----------------
const VISTAS = {
  comandas: { roles: ['admin', 'mozo', 'caja'], fn: vComandas, escucha: ['comandas'] },
  comanda: { roles: ['admin', 'mozo', 'caja', 'cocina'], fn: vComandaDetalle, escucha: ['comandas'] },
  nueva: { roles: ['admin', 'mozo', 'caja'], fn: vEditorComanda, escucha: [] },
  editar: { roles: ['admin', 'mozo', 'caja'], fn: vEditorComanda, escucha: [] },
  tickets: { roles: ['admin', 'caja', 'cocina'], fn: vTickets, escucha: ['comandas'] },
  mesas: { roles: ['admin', 'mozo', 'caja'], fn: vMesas, escucha: ['mesas', 'comandas'] },
  carta: { roles: ['admin', 'mozo', 'cocina', 'caja'], fn: vCarta, escucha: ['productos'] },
  reporte: { roles: ['admin', 'caja'], fn: vReporte, escucha: ['comandas', 'turnos'] },
  comprobantes: { roles: ['admin', 'caja'], fn: vComprobantes, escucha: ['comandas'] },
  admin: { roles: ['admin'], fn: vAdmin, escucha: ['mesas', 'productos', 'turnos'] },
};

function rutaActual() {
  const [ruta, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [nombre, param] = ruta.split('/');
  return { nombre, param, query: new URLSearchParams(qs || '') };
}

async function navegar() {
  if (!S.me) return;
  S.timers.forEach(clearInterval);
  S.timers = [];
  cerrarModal();
  const r = rutaActual();
  const def = VISTAS[r.nombre];
  if (!def || !def.roles.some((r) => (S.me.roles || [S.me.rol]).includes(r))) {
    location.hash = `#/${tabsDelUsuario()[0]}`;
    return;
  }
  const tabActivo = { comanda: 'comandas', nueva: 'comandas', editar: 'comandas' }[r.nombre] || r.nombre;
  $$('.nav a').forEach((a) => a.classList.toggle('activo', a.dataset.tab === tabActivo));
  $('.app')?.classList.remove('abierto');
  const titulo = $('#titulo-vista');
  if (titulo) titulo.textContent = TAB_INFO[tabActivo]?.[0] || '';
  const main = $('#vista');
  S.vista = { nombre: r.nombre, escucha: def.escucha, recargar: () => def.fn(main, r, true) };
  if (!main.dataset.cargado) main.innerHTML = '<div class="vacio">Cargando…</div>';
  window.scrollTo(0, 0);
  try {
    await def.fn(main, r, false);
    main.dataset.cargado = '1';
  } catch (e) {
    if (S.me) main.innerHTML = `<div class="vacio">⚠️ ${esc(e.message)}<br><br><button class="btn" onclick="recargarVista()">Reintentar</button></div>`;
  }
}
window.addEventListener('hashchange', navegar);

async function recargarVista() {
  if (!S.vista) return;
  try {
    await S.vista.recargar();
  } catch (e) {
    console.warn(e);
  }
}
const ir = (hash) => (location.hash = hash);

// ---------------- cobro ----------------
async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Por http en la red local el navegador no da el portapapeles moderno: se usa el método clásico
    const a = Object.assign(document.createElement('textarea'), { value: texto });
    document.body.append(a);
    a.select();
    document.execCommand('copy');
    a.remove();
  }
  toast(`Copiado: ${texto.length > 40 ? `${texto.slice(0, 40)}…` : texto}`, 'ok', 1500);
}

// Detalle para emitir la boleta en SEE-SOL (SUNAT): platos iguales con el mismo precio en una línea
// (las guarniciones no cambian el precio). Cada dato se copia con un toque.
function detalleSunat(comandas, total) {
  const lineas = new Map();
  for (const c of comandas)
    for (const it of c.items) {
      const k = `${it.nombre}|${it.precio}`;
      const l = lineas.get(k) || { nombre: it.nombre, precio: it.precio, cantidad: 0 };
      l.cantidad += it.cantidad;
      lineas.set(k, l);
    }
  const tasa = Number(S.config.tasaIGV) || 0;
  const n2 = (n) => Number(n).toFixed(2);
  const sinIgv = (n) => (n / (1 + tasa / 100)).toFixed(4); // 4 decimales para que el total cuadre
  const celda = (v, num = true) => `<td${num ? ' class="num"' : ''}><button type="button" class="copiable" data-copiar="${esc(v)}">${esc(v)}</button></td>`;
  const filas = [...lineas.values()];
  const todo = filas.map((l) => [l.cantidad, l.nombre, n2(l.precio), n2(l.precio * l.cantidad), ...(tasa ? [sinIgv(l.precio)] : [])].join('\t')).join('\n');
  return `
    <div class="tabla-wrap"><table class="tabla-sunat">
      <thead><tr><th class="num">Cant.</th><th>Descripción</th><th class="num">P. unit.</th><th class="num">Importe</th>${tasa ? `<th class="num">V. unit. sin IGV</th>` : ''}</tr></thead>
      <tbody>${filas
        .map((l) => `<tr>${celda(String(l.cantidad))}${celda(l.nombre, false)}${celda(n2(l.precio))}${celda(n2(l.precio * l.cantidad))}${tasa ? celda(sinIgv(l.precio)) : ''}</tr>`)
        .join('')}</tbody>
      <tfoot><tr><th colspan="3">Total (incluye IGV)</th>${celda(n2(total))}${tasa ? '<td></td>' : ''}</tr></tfoot>
    </table></div>
    <div class="fila entre">
      <small class="suave">Unidad: NIU (unidad) · Toque un dato para copiarlo.${tasa ? ` Valor sin IGV calculado con ${tasa}%.` : ''}</small>
      <button type="button" class="btn chico" data-copiar="${esc(todo)}">Copiar todo</button>
    </div>`;
}

const pendiente = (c) => !c.pagada && c.estado !== 'cancelado';
const etiquetaAtencion = (c) => (c.atencion_numero ? `<span class="etiqueta at">ATENCIÓN #${c.atencion_numero}</span>` : '');

/** Agrupa comandas por atención, en el orden en que aparecen: [[comanda, ...], ...] */
function porAtencion(comandas) {
  const g = new Map();
  for (const c of comandas) {
    const k = c.atencion_id ?? `c${c.id}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(c);
  }
  return [...g.values()];
}

/** Copia de las comandas con solo lo que falta cobrar de cada plato (item.cantidad = pendiente) */
function pendientes(comandas) {
  return comandas
    .filter(pendiente)
    .map((c) => {
      const items = c.items.map((it) => ({ ...it, cantidad: it.cantidad - (it.cobrado || 0) })).filter((it) => it.cantidad > 0);
      return { ...c, items, total: items.reduce((s, it) => s + it.precio * it.cantidad, 0) };
    })
    .filter((c) => c.items.length);
}
const porCobrarDe = (c) => c.total - (c.cobrado || 0);

/** Cobrar una atención: se eligen los platos (y cuántos de cada uno) que paga este cliente; por defecto, todo */
async function cobrarAtencion(atencionId) {
  const cs = pendientes((await api('GET', '/api/comandas?vista=por_cobrar')).filter((c) => c.atencion_id === atencionId));
  if (!cs.length) return toast('Esta atención no tiene nada por cobrar', 'error');
  const titulo = `Cobrar atención #${cs[0].atencion_numero} · ${cs[0].tipo === 'local' ? `Mesa ${cs[0].mesa_numero}` : 'Para llevar'}`;
  const items = cs.flatMap((c) => c.items);
  if (items.length === 1 && items[0].cantidad === 1) return abrirCobro(cs, titulo);
  const sel = new Map(items.map((it) => [it.id, it.cantidad])); // item_id -> unidades a cobrar
  const m = abrirModal(`
    <div class="pila">
      <div class="fila entre"><h3>${esc(titulo)}</h3><button class="btn chico" data-x>✕</button></div>
      <div class="suave peq">Elija lo que paga este cliente. Lo demás queda pendiente en la atención.</div>
      <div class="fila"><button type="button" class="btn chico" data-todo="1">Todo</button><button type="button" class="btn chico" data-todo="0">Nada</button></div>
      ${cs
        .map(
          (c) => `<div class="pila-chica">
            <button type="button" class="link-comanda" data-comanda="${c.id}"><b>Comanda #${c.numero_dia}</b> <span class="suave peq">${esc(c.mozo_nombre || '')} · ${hora(c.creado_en)} · todo / nada</span></button>
            ${c.items
              .map((it) => {
                const g = detalleGuarnicion(it);
                return `<div class="toggle-fila on fila-cobro">
                  <div class="crecer"><div>${esc(it.nombre)} <span class="suave peq">${dinero(it.precio)}</span></div>${g ? `<div class="guar">${g}</div>` : ''}</div>
                  <div class="contador-cant"><button type="button" data-menos="${it.id}">−</button><span class="v" data-n="${it.id}"></span><button type="button" class="mas" data-mas-cobro="${it.id}">＋</button></div>
                </div>`;
              })
              .join('')}
          </div>`
        )
        .join('')}
      <button class="btn acento bloque" id="seguir"></button>
    </div>`);
  $('[data-x]', m).onclick = cerrarModal;
  const maxDe = new Map(items.map((it) => [it.id, it.cantidad]));
  const elegido = () => cs.map((c) => ({ ...c, items: c.items.map((it) => ({ ...it, cantidad: sel.get(it.id) })).filter((it) => it.cantidad) })).filter((c) => c.items.length);
  const pintar = () => {
    for (const [id, n] of sel) {
      $(`[data-n="${id}"]`, m).textContent = `${n}/${maxDe.get(id)}`;
      $(`[data-n="${id}"]`, m).closest('.fila-cobro').classList.toggle('on', n > 0);
    }
    const e = elegido();
    const total = e.reduce((s, c) => s + c.items.reduce((t, it) => t + it.precio * it.cantidad, 0), 0);
    const todo = [...sel].every(([id, n]) => n === maxDe.get(id));
    const b = $('#seguir', m);
    b.disabled = !e.length;
    b.textContent = e.length ? `💵 Cobrar ${todo ? 'todo' : 'lo elegido'} (${dinero(total)})` : 'Elija al menos un plato';
  };
  const poner = (ids, f) => (ids.forEach((id) => sel.set(id, f(id))), pintar());
  $$('[data-menos]', m).forEach((x) => (x.onclick = () => poner([Number(x.dataset.menos)], (id) => Math.max(0, sel.get(id) - 1))));
  $$('[data-mas-cobro]', m).forEach((x) => (x.onclick = () => poner([Number(x.dataset.masCobro)], (id) => Math.min(maxDe.get(id), sel.get(id) + 1))));
  $$('[data-todo]', m).forEach((x) => (x.onclick = () => poner([...sel.keys()], (id) => (x.dataset.todo === '1' ? maxDe.get(id) : 0))));
  $$('[data-comanda]', m).forEach(
    (x) =>
      (x.onclick = () => {
        const ids = cs.find((c) => c.id === Number(x.dataset.comanda)).items.map((it) => it.id);
        const lleno = ids.every((id) => sel.get(id) === maxDe.get(id));
        poner(ids, (id) => (lleno ? 0 : maxDe.get(id)));
      })
  );
  pintar();
  $('#seguir', m).onclick = () => {
    const e = elegido();
    const todo = [...sel].every(([id, n]) => n === maxDe.get(id));
    cerrarModal();
    abrirCobro(e, todo ? titulo : `${titulo} (parte)`);
  };
}

/** Precuenta de lo pendiente: ids de comandas */
const precuentaDe = (ids, ventana) =>
  usaTicketeraCaja()
    ? aTicketera('/api/imprimir/precuenta', { ids }, 'Precuenta enviada a la ticketera')
    : imprimirPDF(`/api/precuenta.pdf?ids=${ids.join(',')}`, ventana);

/** Pasar una atención a otra mesa */
async function moverAtencion(atencionId, mesaActual) {
  const mesas = (await api('GET', '/api/mesas')).filter((m) => m.activa && m.principal_id === m.id && m.id !== mesaActual);
  const m = abrirModal(`
    <div class="pila">
      <div class="fila entre"><h3>Cambiar de mesa</h3><button class="btn chico" data-x>✕</button></div>
      <div class="suave peq">Pasa la atención con todas sus comandas a otra mesa.</div>
      <select class="entrada" id="destino"><option value="">— Elegir mesa —</option>
        ${mesas.map((x) => `<option value="${x.id}">Mesa ${esc(x.etiqueta)} · ${esc(x.piso || '')} · ${x.ocupada ? 'ocupada' : 'libre'}</option>`).join('')}</select>
      <button class="btn primario bloque" id="mover">Mover</button>
    </div>`);
  $('[data-x]', m).onclick = cerrarModal;
  $('#mover', m).onclick = async () => {
    const mesa_id = Number($('#destino', m).value);
    if (!mesa_id) return toast('Elija la mesa', 'error');
    try {
      const r = await api('POST', `/api/atenciones/${atencionId}/mover`, { mesa_id });
      cerrarModal();
      toast(`Atención movida a la mesa ${r.mesa_etiqueta}`, 'ok');
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

/** comandas: solo con los platos y cantidades que se cobran (ver pendientes()) */
function abrirCobro(comandas, titulo) {
  const total = Math.round(comandas.reduce((s, c) => s + c.items.reduce((t, it) => t + it.precio * it.cantidad, 0), 0) * 100) / 100;
  const metodos = S.config.metodosPago || ['Efectivo'];
  // la primera forma de pago se lleva lo que falte; las demás tienen su monto (pago mixto)
  const pagos = [{ metodo: metodos[0], monto: total }];
  const r2 = (n) => Math.round(n * 100) / 100;
  const balancear = () => (pagos[0].monto = r2(total - pagos.slice(1).reduce((s, p) => s + (Number(p.monto) || 0), 0)));
  const efectivo = () => pagos.filter((p) => p.metodo === 'Efectivo').reduce((s, p) => s + p.monto, 0);
  const pagosValidos = () => pagos.every((p) => p.monto > 0);
  let tipoComprobante = 'nota';
  let xml = null; // { base64, vista } del comprobante emitido en SOL
  const m = abrirModal(`
    <div class="pila">
      <div class="fila entre"><h3>${esc(titulo)}</h3><button class="btn chico" data-x>✕</button></div>
      <div class="suave">${comandas.map((c) => `#${c.numero_dia}`).join(', ')}</div>
      <div class="total-cobro">${dinero(total)}</div>
      <div><div class="etiqueta-campo">Comprobante</div>
        <div class="segmento" id="tipo-comprobante">
          <button type="button" data-comp="nota" class="activo">🧾 Nota de venta</button>
          <button type="button" data-comp="sunat">🏛️ Boleta o factura (SUNAT)</button>
        </div></div>
      <div id="bloque-sunat" class="pila oculto">
        <div class="aviso-suave">1) Emita la boleta o factura en SOL con estos datos. 2) Arrastre aquí el ZIP que descarga
          (o toque el recuadro para elegirlo). 3) Cobre: se imprime al momento.</div>
        <button type="button" class="btn bloque" id="ver-sunat">📋 Detalle para SOL</button>
        <div id="sunat" class="pila">${detalleSunat(comandas, total)}</div>
        <label class="tarjeta zona-xml" id="zona-cobro">
          <input type="file" accept=".xml,.zip,text/xml,application/xml,application/zip" id="xml-cobro" hidden>
          <b>⬆️ Arrastre aquí el ZIP o XML de SUNAT</b>
          <span class="suave peq">o toque para elegirlo</span>
        </label>
        <div id="vista-xml" class="oculto"></div>
      </div>
      <div><div class="etiqueta-campo">Forma de pago</div><div id="pagos" class="pila"></div></div>
      <label class="campo" id="campo-recibido"><span>Recibido en efectivo (opcional, para calcular el vuelto)</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" id="recibido"></label>
      <div class="suave" id="vuelto"></div>
      <div class="error" data-err></div>
      <button class="btn acento bloque" id="cobrar">💵 Cobrar e imprimir nota de venta</button>
    </div>`);
  $('[data-x]', m).onclick = cerrarModal;
  $('#ver-sunat', m).onclick = () => $('#sunat', m).classList.toggle('oculto');
  $$('[data-copiar]', m).forEach((b) => (b.onclick = () => copiar(b.dataset.copiar)));

  const nombreXML = (v) => `${v.tipo === '01' ? 'Factura' : 'Boleta'} ${v.numero}`;
  function actualizarBoton() {
    const b = $('#cobrar', m);
    b.classList.toggle('peligro', !!(xml && xml.vista.coincide === false));
    b.textContent =
      tipoComprobante === 'nota'
        ? '💵 Cobrar e imprimir nota de venta'
        : !xml
        ? '💵 Cobrar sin comprobante (subir el XML después)'
        : xml.vista.coincide === false
        ? `⚠️ Cobrar igual e imprimir ${nombreXML(xml.vista)}`
        : `💵 Cobrar e imprimir ${nombreXML(xml.vista)}`;
  }
  function elegirComprobante(tipo) {
    tipoComprobante = tipo;
    $$('[data-comp]', m).forEach((x) => x.classList.toggle('activo', x.dataset.comp === tipo));
    $('#bloque-sunat', m).classList.toggle('oculto', tipo !== 'sunat');
    actualizarBoton();
  }
  $$('[data-comp]', m).forEach((b) => (b.onclick = () => elegirComprobante(b.dataset.comp)));

  function mostrarXML() {
    const caja = $('#vista-xml', m);
    $('#zona-cobro', m).classList.toggle('oculto', !!xml);
    caja.classList.toggle('oculto', !xml);
    if (!xml) return (caja.innerHTML = '');
    const v = xml.vista;
    const cliente = [v.cliente.doc ? `${v.cliente.tipoDocTexto || 'Doc.'} ${v.cliente.doc}` : '', v.cliente.nombre].filter(Boolean).join(' · ');
    caja.innerHTML = `<div class="tarjeta vista-xml ${v.coincide === false ? 'falla' : ''}">
        <div class="fila entre"><b>🏛️ ${esc(nombreXML(v))}</b><button type="button" class="btn chico" id="quitar-xml">Cambiar</button></div>
        <div class="suave peq">${esc(cliente || 'Cliente sin documento')} · ${v.items} producto(s)</div>
        <div>${v.coincide === false ? `⚠️ <b class="error-txt">Total ${dinero(v.total)}: no coincide con el cobro (${dinero(total)})</b>` : `✅ Total ${dinero(v.total)}, coincide con el cobro`}</div>
        ${v.avisos.map((a) => `<div class="peq error-txt">⚠️ ${esc(a)}</div>`).join('')}
      </div>`;
    $('#quitar-xml', m).onclick = () => {
      xml = null;
      mostrarXML();
      actualizarBoton();
    };
  }

  async function cargarXML(archivo) {
    if (!archivo) return;
    elegirComprobante('sunat');
    const err = $('[data-err]', m);
    err.textContent = '';
    if (archivo.size > 700 * 1024) return (err.textContent = 'El archivo es demasiado grande para ser un XML de SUNAT');
    try {
      const base64 = await leerArchivo(archivo);
      xml = { base64, vista: await api('POST', '/api/sunat/leer', { contenido: base64, total }) };
      $('#sunat', m).classList.add('oculto'); // ya se emitió: el detalle ya no hace falta
    } catch (e) {
      xml = null;
      err.textContent = e.message;
    }
    mostrarXML();
    actualizarBoton();
  }
  const input = $('#xml-cobro', m);
  input.onchange = () => {
    cargarXML(input.files[0]);
    input.value = '';
  };
  // se puede soltar el archivo en cualquier parte de la ventana de cobro
  const zona = $('#zona-cobro', m);
  m.ondragover = (e) => {
    e.preventDefault();
    zona.classList.add('encima');
  };
  m.ondragleave = (e) => {
    if (e.target === m) zona.classList.remove('encima');
  };
  m.ondrop = (e) => {
    e.preventDefault();
    zona.classList.remove('encima');
    cargarXML(e.dataTransfer?.files?.[0]);
  };

  const recibido = $('#recibido', m);
  const pintarVuelto = () => {
    const ef = efectivo();
    const r = Number(recibido.value);
    $('#campo-recibido', m).classList.toggle('oculto', !ef);
    $('#vuelto', m).classList.toggle('oculto', !ef);
    recibido.placeholder = ef.toFixed(2);
    $('#vuelto', m).textContent = ef && recibido.value && r >= ef ? `Vuelto: ${dinero(r - ef)}` : '';
  };
  recibido.oninput = pintarVuelto;
  // Una forma de pago: chips. Pago mixto: una fila por forma, la primera se ajusta sola al resto
  function pintarPagos() {
    balancear();
    const caja = $('#pagos', m);
    const chipsDe = (i) =>
      metodos.map((x) => `<button type="button" class="chip ${x === pagos[i].metodo ? 'activo' : ''}" data-pago="${i}" data-metodo="${esc(x)}">${esc(x)}</button>`).join('');
    caja.innerHTML =
      pagos.length === 1
        ? `<div class="opciones">${chipsDe(0)}</div>
           <button type="button" class="btn chico" id="mixto">➕ Pagar con dos formas (mixto)</button>`
        : `${pagos
            .map(
              (p, i) => `<div class="tarjeta pila-chica pago-fila">
                <div class="fila entre"><b>${i === 0 ? 'Resto' : `Pago ${i + 1}`}</b>
                  ${i === 0 ? `<b class="${p.monto > 0 ? '' : 'falta'}">${dinero(p.monto)}</b>`
                    : `<span class="fila"><input class="entrada" type="number" inputmode="decimal" step="0.1" min="0" data-monto="${i}" value="${p.monto || ''}" placeholder="Monto" style="width:110px">
                       <button type="button" class="btn chico" data-quitar-pago="${i}" aria-label="Quitar">✕</button></span>`}</div>
                <div class="opciones">${chipsDe(i)}</div></div>`
            )
            .join('')}
           ${pagos[0].monto > 0 ? '' : '<div class="error">Los pagos superan el total</div>'}
           <button type="button" class="btn chico" id="mixto">➕ Otra forma de pago</button>`;
    $$('[data-metodo]', caja).forEach((b) => (b.onclick = () => ((pagos[b.dataset.pago].metodo = b.dataset.metodo), pintarPagos())));
    $$('[data-monto]', caja).forEach(
      (x) =>
        (x.onchange = () => {
          pagos[x.dataset.monto].monto = r2(Number(x.value) || 0);
          pintarPagos();
        })
    );
    $$('[data-quitar-pago]', caja).forEach((b) => (b.onclick = () => (pagos.splice(Number(b.dataset.quitarPago), 1), pintarPagos())));
    $('#mixto', caja).onclick = () => {
      pagos.push({ metodo: metodos.find((x) => !pagos.some((p) => p.metodo === x)) || metodos[0], monto: 0 });
      pintarPagos();
      $(`[data-monto="${pagos.length - 1}"]`, caja)?.focus();
    };
    pintarVuelto();
    $('#cobrar', m).disabled = !pagosValidos();
  }
  pintarPagos();

  $('#cobrar', m).onclick = async (e) => {
    const sunat = tipoComprobante === 'sunat';
    if (sunat && xml?.vista.coincide === false && !(await confirmarEnCobro())) return;
    if (!pagosValidos()) return ($('[data-err]', m).textContent = 'Revise los montos de cada forma de pago');
    const metodo = pagos.length > 1 ? 'Mixto' : pagos[0].metodo;
    e.target.disabled = true;
    const imprime = !sunat || xml; // sin XML no se imprime nada todavía
    const ventana = imprime && !usaTicketeraCaja() ? prepararVentana() : null;
    try {
      const cobro = await api('POST', '/api/cobros', {
        items: comandas.flatMap((c) => c.items.map((it) => ({ item_id: it.id, cantidad: it.cantidad }))),
        pagos: pagos.map((p) => ({ metodo: p.metodo, monto: p.monto })),
        comprobante: tipoComprobante,
        recibido: efectivo() && recibido.value !== '' ? Number(recibido.value) : null,
        ...(sunat && xml ? { sunat_xml: xml.base64, aceptar_diferencia: xml.vista.coincide === false } : {}),
      });
      cerrarModal();
      if (sunat && xml) {
        toast(`Cobro registrado (${metodo}) con ${nombreXML(xml.vista)}`, 'ok');
        imprimirSunat(cobro.sunat_id, ventana);
      } else if (sunat) {
        toast(`Cobro registrado (${metodo}). Suba el XML en Comprobantes SUNAT cuando lo tenga.`, 'ok', 6000);
      } else {
        toast(`Cobro registrado (${metodo})`, 'ok');
        if (usaTicketeraCaja()) aTicketera('/api/imprimir/comprobante', { cobro_id: cobro.id }, 'Nota de venta enviada a la ticketera');
        else imprimirPDF(`/api/cobros/${cobro.id}/comprobante.pdf`, ventana);
      }
      recargarVista();
    } catch (err) {
      ventana?.close();
      $('[data-err]', m).textContent = err.message;
      e.target.disabled = false;
    }
  };

  // confirmación dentro de la misma ventana (abrir otro modal cerraría la de cobro)
  function confirmarEnCobro() {
    return new Promise((resolve) => {
      const err = $('[data-err]', m);
      err.innerHTML = `El total de la ${xml.vista.tipo === '01' ? 'factura' : 'boleta'} ${esc(xml.vista.numero)} no coincide con el cobro.
        <button type="button" class="btn chico peligro" id="si-cobrar">Cobrar igual</button>`;
      $('#si-cobrar', m).onclick = () => {
        err.textContent = '';
        resolve(true);
      };
    });
  }
}

// ---------------- acciones (delegación de clicks) ----------------
const ACCIONES = {
  colapsar: () => {
    const c = $('.app').classList.toggle('colapsado');
    try {
      localStorage.setItem('lateral', c ? 'colapsado' : '');
    } catch {}
  },
  'menu-movil': () => $('.app').classList.toggle('abierto'),
  'menu-usuario': () => {
    const t = S.me.turno;
    const m = abrirModal(`
      <div class="pila">
        <div class="fila entre"><h3>${esc(S.me.nombre)}</h3><button class="btn chico" data-x>✕</button></div>
        <div class="suave">${(S.me.roles || [S.me.rol]).map((r) => ROL_TXT[r]).join(' + ')} · usuario <b>${esc(S.me.usuario)}</b></div>
        <div class="tarjeta">${t ? `🟢 En turno desde las <b>${hora(t.inicio)}</b>` : '⚪ Sin turno abierto hoy'}</div>
        ${t ? '' : '<button class="btn ok bloque" data-a="iniciar">Iniciar turno</button>'}
        <button class="btn bloque" data-a="salir">Cerrar sesión (seguir en turno)</button>
        <button class="btn peligro bloque" data-a="fin">Finalizar turno y salir</button>
        <div class="fila entre envolver suave peq">
          <span>📱 Desde los celulares: <b>${esc(direccionCelular() || location.origin)}</b></span>
          <button class="btn chico" id="ver-direccion">Ver QR</button>
        </div>
      </div>`);
    $('[data-x]', m).onclick = cerrarModal;
    $('#ver-direccion', m).onclick = mostrarDireccion;
    $$('[data-a]', m).forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            if (b.dataset.a === 'iniciar') {
              S.me.turno = await api('POST', '/api/turnos/iniciar');
              cerrarModal();
              toast('Turno iniciado', 'ok');
              return;
            }
            await api('POST', '/api/logout', { finalizarTurno: b.dataset.a === 'fin' });
            S.me = null;
            cerrarSSE();
            location.hash = '';
            renderLogin(b.dataset.a === 'fin' ? 'Turno finalizado. ¡Hasta pronto!' : '');
          } catch (e) {
            toast(e.message, 'error');
          }
        })
    );
  },
  'ver-comanda': (el) => ir(`#/comanda/${el.dataset.id}`),
  'editar-comanda': (el) => ir(`#/editar/${el.dataset.id}`),
  'nueva-comanda': (el) => {
    const q = new URLSearchParams();
    if (el.dataset.mesa) q.set('mesa', el.dataset.mesa);
    if (el.dataset.atencion) q.set('atencion', el.dataset.atencion);
    ir(`#/nueva${q.size ? `?${q}` : ''}`);
  },
  'cobrar-atencion': async (el) => {
    try {
      await cobrarAtencion(Number(el.dataset.atencion));
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  'precuenta-atencion': async (el) => {
    const ventana = usaTicketeraCaja() ? null : prepararVentana(); // antes del await, para que el celular no bloquee la ventana
    try {
      const ids = (await api('GET', '/api/comandas?vista=por_cobrar')).filter((c) => c.atencion_id === Number(el.dataset.atencion)).map((c) => c.id);
      if (!ids.length) throw new Error('No hay consumo pendiente para la precuenta');
      precuentaDe(ids, ventana);
    } catch (e) {
      ventana?.close();
      toast(e.message, 'error');
    }
  },
  'mover-atencion': (el) => moverAtencion(Number(el.dataset.atencion), Number(el.dataset.mesa)).catch((e) => toast(e.message, 'error')),
  estado: async (el) => {
    const { id, estado } = el.dataset;
    if (estado === 'cancelado' && !(await confirmar('¿Cancelar esta comanda?', { ok: 'Sí, cancelar', peligro: true }))) return;
    el.disabled = true;
    try {
      await api('POST', `/api/comandas/${id}/estado`, { estado });
      toast(estado === 'enviado_cocina' ? 'Enviada a cocina: el ticket queda listo para imprimir' : `Comanda → ${ESTADO_TXT[estado]}`, 'ok', 2200);
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
      el.disabled = false;
    }
  },
  cobrar: async (el) => {
    try {
      const c = await api('GET', `/api/comandas/${el.dataset.id}`);
      if (c.atencion_id) return cobrarAtencion(c.atencion_id);
      abrirCobro(pendientes([c]), `Cobrar comanda #${c.numero_dia}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  comprobante: (el) =>
    usaTicketeraCaja()
      ? aTicketera('/api/imprimir/comprobante', { cobro_id: Number(el.dataset.cobro) }, 'Nota de venta enviada a la ticketera')
      : imprimirPDF(`/api/cobros/${el.dataset.cobro}/comprobante.pdf`),
  'imprimir-sunat': (el) => imprimirSunat(Number(el.dataset.id)),
  'ir-comprobantes': () => ir('#/comprobantes'),
  'comprobante-pdf': (el) => imprimirPDF(`/api/cobros/${el.dataset.cobro}/comprobante.pdf`),
  'anular-cobro': async (el) => {
    if (!(await confirmar('¿Anular este cobro? Sus platos vuelven a quedar por cobrar.', { ok: 'Anular cobro', peligro: true }))) return;
    try {
      await api('POST', `/api/cobros/${el.dataset.cobro}/anular`);
      toast('Cobro anulado', 'ok');
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  'imprimir-ticket': async (el) => {
    const ids = el.dataset.ids;
    if (S.ticketera?.activa) {
      const n = ids.split(',').length;
      return aTicketera('/api/imprimir/comanda', { ids: ids.split(',').map(Number) }, n > 1 ? `${n} tickets enviados a la ticketera` : 'Ticket enviado a la ticketera');
    }
    imprimirPDF(`/api/tickets.pdf?ids=${ids}`);
    try {
      await api('POST', '/api/tickets/impresos', { ids: ids.split(',').map(Number) });
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  'eliminar-comanda': async (el) => {
    if (!(await confirmar('¿Eliminar definitivamente esta comanda?', { ok: 'Eliminar', peligro: true }))) return;
    try {
      await api('DELETE', `/api/comandas/${el.dataset.id}`);
      toast('Comanda eliminada', 'ok');
      ir('#/comandas');
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  disponible: async (el) => {
    try {
      await api('POST', `/api/productos/${el.dataset.id}/disponible`, { disponible: el.dataset.v === '1' });
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  volver: () => (history.length > 1 ? history.back() : ir('#/comandas')),
};

// soltar un archivo fuera de una zona de carga no debe abrirlo en el navegador
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault());

document.addEventListener('click', (e) => {
  desbloquearAudio();
  const el = e.target.closest('[data-accion]');
  if (!el || !ACCIONES[el.dataset.accion]) return;
  e.preventDefault();
  e.stopPropagation();
  ACCIONES[el.dataset.accion](el, e);
});

// ---------------- componentes ----------------
const badge = (estado) => `<span class="estado ${claseEstado(estado)}">${ESTADO_TXT[estado]}</span>`;
const lugar = (c) =>
  c.tipo === 'local'
    ? `<b>Mesa ${esc(c.mesa_numero ?? '?')}</b>${c.mesa_piso ? ` <span class="suave peq">· ${esc(c.mesa_piso)}</span>` : ''}`
    : `<span class="etiqueta llevar">PARA LLEVAR</span>${c.cliente ? ` <b>${esc(c.cliente)}</b>` : ''}`;

/** Texto de guarniciones de un ítem de comanda */
function detalleGuarnicion(it) {
  const partes = it.sopa ? [`Sopa: ${esc(it.sopa)}`] : [];
  if (it.refresco) partes.push(`Refresco: ${esc(it.refresco)}`);
  if (it.guarnicion_defecto && !it.guarnicion_base) partes.push(`<b>sin ${esc(it.guarnicion_defecto.toLowerCase())}</b>`);
  else if (it.guarnicion_base && it.guarnicion_defecto && it.guarnicion_base !== it.guarnicion_defecto)
    partes.push(`<b>${esc(it.guarnicion_base)}</b> (cambio)`);
  else if (it.guarnicion_base) partes.push(esc(it.guarnicion_base));
  if (it.guarnicion_eleccion) partes.push(esc(it.guarnicion_eleccion));
  return partes.join(' + ');
}
const lineaItem = (i) => {
  const g = detalleGuarnicion(i);
  return `<li>${i.cantidad}× ${esc(i.nombre)}${g ? `<div class="guar">${g}</div>` : ''}${i.nota ? `<div class="guar nota-item">📝 ${esc(i.nota)}</div>` : ''}</li>`;
};

function botonesComanda(c) {
  const b = [];
  const btn = (estado, texto, clase = '') =>
    `<button class="btn chico ${clase}" data-accion="estado" data-id="${c.id}" data-estado="${estado}">${texto}</button>`;
  if (c.estado === 'generado' && puede('admin', 'mozo', 'caja')) {
    if (!c.cobrado) b.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar</button>`);
    b.push(btn('enviado_cocina', '🍳 Enviar a cocina', 'primario'));
  }
  if (EN_COCINA.includes(c.estado) && puede('admin', 'mozo', 'caja')) b.push(btn('entregado', '🍽️ Entregado', 'ok'));
  if (puede('admin', 'caja') && !c.pagada && c.estado !== 'cancelado')
    b.push(`<button class="btn chico acento" data-accion="cobrar" data-id="${c.id}">💵 Cobrar</button>`);
  return b.join('');
}

const etiquetaPago = (c) =>
  c.pagada
    ? `<span class="etiqueta pagada">PAGADA${c.metodo_pago ? ` · ${esc(c.metodo_pago.replaceAll(',', ' + ').toUpperCase())}` : ''}</span>`
    : c.cobrado > 0
      ? `<span class="etiqueta llevar">PAGO PARCIAL · FALTA ${dinero(porCobrarDe(c))}</span>`
      : '';

function tarjetaComanda(c) {
  const pendienteTicket = EN_COCINA.includes(c.estado) && !c.ticket_impreso;
  return `
    <div class="tarjeta comanda ${claseEstado(c.estado)}" data-accion="ver-comanda" data-id="${c.id}">
      <div class="fila entre"><span class="num">#${c.numero_dia}</span>${badge(c.estado)}</div>
      <div class="fila envolver" style="margin-top:4px">${lugar(c)} ${etiquetaAtencion(c)}
        <span class="suave peq">· ${esc(c.mozo_nombre || '')} · ${hora(c.creado_en)}</span>
        ${etiquetaPago(c)}
        ${pendienteTicket ? '<span class="etiqueta llevar">🖨️ TICKET PENDIENTE</span>' : ''}</div>
      <ul class="items">${c.items.map(lineaItem).join('')}</ul>
      ${c.nota ? `<div class="nota">📝 ${esc(c.nota)}</div>` : ''}
      <div class="fila entre" style="margin-top:6px"><b>${dinero(c.total)}</b></div>
      <div class="acciones">${botonesComanda(c)}</div>
    </div>`;
}

const chips = (opciones, actual, accion) =>
  `<div class="chips">${opciones
    .map(([v, t]) => `<button class="chip ${v === actual ? 'activo' : ''}" data-chip="${accion}" data-v="${v}">${esc(t)}</button>`)
    .join('')}</div>`;

function enlazarChips(main, accion, fn) {
  $$(`[data-chip="${accion}"]`, main).forEach((b) => (b.onclick = () => fn(b.dataset.v)));
}

// ================= VISTAS =================

// ---------- Lista de comandas ----------
async function vComandas(main) {
  const filtros = [
    ['activas', 'Activas'],
    ...(puede('mozo') ? [['mias', 'Mías']] : []),
    ...(puede('admin', 'caja') ? [['por_cobrar', 'Por cobrar']] : []),
    ['todas', 'Todas de hoy'],
  ];
  if (!filtros.some(([v]) => v === S.filtroComandas)) S.filtroComandas = 'activas';
  const f = S.filtroComandas;
  const qs = f === 'mias' ? 'vista=activas&mias=1' : f === 'todas' ? '' : `vista=${f}`;
  const lista = await api('GET', `/api/comandas${qs ? `?${qs}` : ''}`);
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>Comandas</h2>
        <span class="suave peq">${lista.length} ${lista.length === 1 ? 'comanda' : 'comandas'}</span></div>
      ${chips(filtros, f, 'filtro')}
      ${lista.length ? (soloCocina() ? `<div class="grid">${lista.map(tarjetaComanda).join('')}</div>` : porAtencion(lista).map(bloqueAtencion).join('')) : '<div class="vacio">No hay comandas en esta vista.</div>'}
    </div>
    <button class="btn primario fab" data-accion="nueva-comanda">＋ Nueva comanda</button>`;
  enlazarChips(main, 'filtro', (v) => {
    S.filtroComandas = v;
    vComandas(main);
  });
}

/** Una atención con sus comandas: cabecera con lugar, total pendiente y acciones */
function bloqueAtencion(cs, { mesa = false } = {}) {
  // totales de la atención completa (la vista puede mostrar solo parte de sus comandas)
  const [c] = cs;
  const porCobrar = c.atencion_id ? c.atencion_por_cobrar : cs.filter(pendiente).reduce((s, x) => s + porCobrarDe(x), 0);
  const n = c.atencion_comandas ?? cs.length;
  const acciones = [];
  if (porCobrar > 0 && c.atencion_id) {
    if (puede('admin', 'caja')) acciones.push(`<button class="btn chico acento" data-accion="cobrar-atencion" data-atencion="${c.atencion_id}">💵 Cobrar</button>`);
    acciones.push(`<button class="btn chico" data-accion="precuenta-atencion" data-atencion="${c.atencion_id}">🧾 Precuenta</button>`);
    if (c.tipo === 'local') {
      acciones.push(`<button class="btn chico primario" data-accion="nueva-comanda" data-mesa="${c.mesa_id}" data-atencion="${c.atencion_id}">＋ Comanda</button>`);
      acciones.push(`<button class="btn chico" data-accion="mover-atencion" data-atencion="${c.atencion_id}" data-mesa="${c.mesa_id}">⇄ Mesa</button>`);
    }
  }
  return `
    <section class="atencion">
      <div class="atencion-cab">
        <div><b>${c.atencion_numero ? `Atención #${c.atencion_numero}` : `Comanda #${c.numero_dia}`}</b> ${mesa ? '' : `· ${lugar(c)}`}
          <span class="suave peq">· ${n} ${n === 1 ? 'comanda' : 'comandas'}${porCobrar ? ` · por cobrar <b>${dinero(porCobrar)}</b>` : ''}</span></div>
        <div class="fila envolver">${acciones.join('')}</div>
      </div>
      <div class="grid">${cs.map(tarjetaComanda).join('')}</div>
    </section>`;
}

// ---------- Detalle ----------
async function vComandaDetalle(main, r) {
  const c = await api('GET', `/api/comandas/${r.param}`);
  const acciones = [];
  if (!soloCocina()) acciones.push(botonesComanda(c));
  if (EN_COCINA.includes(c.estado) || c.estado === 'entregado')
    if (puede('admin', 'caja', 'cocina'))
      acciones.push(`<button class="btn chico" data-accion="imprimir-ticket" data-ids="${c.id}">🖨️ ${c.ticket_impreso ? 'Reimprimir' : 'Imprimir'} ticket</button>`);
  // Cobros de la comanda (con cuenta dividida puede haber varios): comprobante y anular cada uno
  const cobros =
    c.cobros?.length && puede('admin', 'caja')
      ? `<div class="tarjeta pila"><h3>Cobros</h3>${c.cobros
          .map((co) => {
            const sunat =
              co.comprobante !== 'sunat'
                ? ''
                : co.sunat_id
                  ? `<button class="btn chico primario" data-accion="imprimir-sunat" data-id="${co.sunat_id}">🏛️ ${esc(co.sunat_numero)}</button>`
                  : '<button class="btn chico acento" data-accion="ir-comprobantes">🏛️ Falta subir el XML de SUNAT</button>';
            return `<div class="fila entre envolver">
              <span><b>N° ${String(co.id).padStart(6, '0')}</b> · ${dinero(co.total)} · ${esc(co.metodo)} <span class="suave peq">· ${hora(co.creado_en)}</span></span>
              <span class="fila envolver">${sunat}
                <button class="btn chico" data-accion="comprobante" data-cobro="${co.id}">🧾 Nota de venta</button>
                ${usaTicketeraCaja() ? `<button class="btn chico" data-accion="comprobante-pdf" data-cobro="${co.id}">PDF</button>` : ''}
                <button class="btn chico" data-accion="anular-cobro" data-cobro="${co.id}">Anular</button></span>
            </div>`;
          })
          .join('')}</div>`
      : '';
  const puedeCancelar =
    !c.cobrado &&
    ((c.estado === 'generado' && puede('mozo', 'caja', 'admin')) ||
      (EN_COCINA.includes(c.estado) && puede('caja', 'admin')));
  if (puedeCancelar)
    acciones.push(`<button class="btn chico peligro" data-accion="estado" data-id="${c.id}" data-estado="cancelado">Cancelar comanda</button>`);
  if (puede('admin') && EN_COCINA.includes(c.estado) && !c.cobrado)
    acciones.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar (admin)</button>`);
  if (puede('admin') && !c.cobrado) acciones.push(`<button class="btn chico peligro" data-accion="eliminar-comanda" data-id="${c.id}">🗑 Eliminar</button>`);

  main.innerHTML = `
    <div class="pila">
      <div class="fila"><button class="btn chico" data-accion="volver">← Volver</button></div>
      <div class="tarjeta comanda ${claseEstado(c.estado)}" style="cursor:default">
        <div class="fila entre"><span class="num">Comanda #${c.numero_dia}</span>${badge(c.estado)}</div>
        <div class="fila envolver" style="margin-top:6px">${lugar(c)} ${etiquetaAtencion(c)}
          ${etiquetaPago(c)}</div>
        <div class="suave peq">Mozo: ${esc(c.mozo_nombre || '-')} · Creada ${hora(c.creado_en)} · ${esc(c.fecha)}</div>
        <div class="tabla-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Cant.</th><th>Plato</th><th class="num">P. unit</th><th class="num">Subtotal</th></tr></thead>
          <tbody>${c.items
            .map((i) => {
              const g = detalleGuarnicion(i);
              const parcial = i.cobrado > 0 && i.cobrado < i.cantidad ? ` <span class="etiqueta llevar">${i.cobrado}/${i.cantidad} COBRADO</span>` : '';
              return `<tr><td><b>${i.cantidad}</b></td><td>${esc(i.nombre)}${i.tipo === 'menu' ? ' <span class="etiqueta">MENÚ</span>' : ''}${parcial}
                ${g ? `<div class="guar">${g}</div>` : ''}${i.nota ? `<div class="nota">${esc(i.nota)}</div>` : ''}</td>
                <td class="num">${dinero(i.precio)}</td><td class="num">${dinero(i.precio * i.cantidad)}</td></tr>`;
            })
            .join('')}</tbody>
          <tfoot><tr><th colspan="3">Total</th><th class="num" style="font-size:1.05rem;color:var(--texto)">${dinero(c.total)}</th></tr></tfoot>
        </table></div>
        ${c.nota ? `<div class="nota" style="margin-top:8px">📝 ${esc(c.nota)}</div>` : ''}
        <div class="acciones">${acciones.join('')}</div>
      </div>
      ${cobros}
      <div class="tarjeta">
        <h3>Seguimiento</h3>
        <ul class="timeline">${c.historial
          .map((h) => `<li><span class="suave peq" style="width:44px">${hora(h.fecha)}</span>${badge(h.estado)}<span class="suave peq">${esc(h.usuario || '')}</span></li>`)
          .join('')}</ul>
      </div>
    </div>`;
}

// ---------- Crear / editar comanda ----------
async function vEditorComanda(main, r, esRecarga) {
  if (esRecarga) return; // no se recarga en vivo para no perder lo que se está escribiendo
  const editando = r.nombre === 'editar';
  const [todasMesas, carta, existente, pendientes] = await Promise.all([
    api('GET', '/api/mesas'),
    api('GET', '/api/carta'),
    editando ? api('GET', `/api/comandas/${r.param}`) : null,
    api('GET', '/api/comandas?vista=por_cobrar'),
  ]);
  // atenciones abiertas de una mesa: [[comanda, ...], ...]
  const atencionesDe = (mesaId) => porAtencion(pendientes.filter((c) => c.tipo === 'local' && c.mesa_id === mesaId && c.atencion_id));
  // con una sola atención abierta va ahí; con varias hay que elegir; 'nueva' abre otra
  const atencionPorDefecto = (mesaId) => {
    const as = atencionesDe(mesaId);
    return as.length === 1 ? as[0][0].atencion_id : null;
  };
  // mesas unidas: se elige el grupo ("10-11"), que se guarda en la mesa principal
  const mesas = todasMesas.filter((m) => m.principal_id === m.id);
  const principalDe = (id) => todasMesas.find((m) => m.id === id)?.principal_id || null;
  // el menú se cobra a precio fijo, sea cual sea el segundo
  for (const p of carta.menu) p.precio = carta.precio_menu;
  const productos = [...carta.menu, ...carta.extras, ...(carta.bebidas || [])];
  const porId = new Map(productos.map((p) => [p.id, p]));
  const guarniciones = carta.guarniciones; // activas
  const guarPorId = new Map(guarniciones.map((g) => [g.id, g]));
  // a elección: solo las marcadas para el día (Gestión → Carta del día)
  const opcionesEleccion = guarniciones.filter((g) => g.del_dia);
  const incluidoMenu = [carta.sopa && `Sopa: ${esc(carta.sopa.nombre)}`, carta.refresco && `Refresco: ${esc(carta.refresco.nombre)}`].filter(Boolean);

  const b = {
    id: existente?.id || null,
    tipo: existente?.tipo || r.query.get('tipo') || (puede('caja') && !puede('mozo') ? 'llevar' : 'local'),
    mesa_id: existente?.mesa_id || principalDe(Number(r.query.get('mesa'))),
    cliente: existente?.cliente || '',
    nota: existente?.nota || '',
    atencion: null, // id de atención | 'nueva' | null (la única abierta de la mesa, o una nueva si no hay)
    lineas: [], // { producto_id, cantidad, nota, base (id|null), eleccion (id|null) }
    estadoOriginal: existente?.estado || 'generado',
  };
  if (existente)
    for (const i of existente.items)
      if (i.producto_id && porId.has(i.producto_id))
        b.lineas.push({
          producto_id: i.producto_id,
          cantidad: i.cantidad,
          nota: i.nota,
          base: i.guarnicion_base_id || null,
          eleccion: i.guarnicion_eleccion_id || null,
        });
  const lineasGuardadas = JSON.stringify(b.lineas);
  if (r.query.get('mesa')) b.tipo = 'local';
  const atencionQuery = r.query.get('atencion');
  b.atencion = existente?.atencion_id || (atencionQuery === 'nueva' ? 'nueva' : Number(atencionQuery) || atencionPorDefecto(b.mesa_id));
  if (existente?.mesa_id && !mesas.find((m) => m.id === existente.mesa_id))
    mesas.push({ id: existente.mesa_id, numero: existente.mesa_numero, ocupada: true });

  const total = () => b.lineas.reduce((s, l) => s + (porId.get(l.producto_id)?.precio || 0) * l.cantidad, 0);
  const cantidadTotal = () => b.lineas.reduce((s, l) => s + l.cantidad, 0);
  const cantidadDe = (pid) => b.lineas.filter((l) => l.producto_id === pid).reduce((s, l) => s + l.cantidad, 0);
  const nombreG = (id) => guarPorId.get(id)?.nombre || '';
  const mismaConfig = (a, c) => a.producto_id === c.producto_id && a.base === c.base && a.eleccion === c.eleccion && (a.nota || '') === (c.nota || '');

  function textoLinea(l) {
    const p = porId.get(l.producto_id);
    if (p.tipo === 'bebidas') return '';
    const partes = p.tipo === 'menu' ? [...incluidoMenu] : [];
    if (p.guarnicion_base_id) {
      if (!l.base) partes.push(`<b>sin ${esc(p.guarnicion_base.toLowerCase())}</b>`);
      else if (l.base !== p.guarnicion_base_id) partes.push(`<b>${esc(nombreG(l.base))}</b> (cambio)`);
      else partes.push(esc(p.guarnicion_base));
    }
    if (p.con_eleccion && opcionesEleccion.length) partes.push(l.eleccion ? esc(nombreG(l.eleccion)) : '<span class="falta">sin guarnición a elección</span>');
    return partes.join(' + ');
  }

  function agregarLinea(nueva) {
    const igual = b.lineas.find((l) => mismaConfig(l, nueva));
    if (igual) igual.cantidad = Math.min(99, igual.cantidad + nueva.cantidad);
    else b.lineas.push(nueva);
  }

  // Modal para elegir guarniciones, cantidad y nota de un plato
  function configurarPlato(p, idx) {
    const l = idx != null ? b.lineas[idx] : { producto_id: p.id, cantidad: 1, nota: '', base: p.guarnicion_base_id || null, eleccion: null };
    let base = l.base;
    let eleccion = l.eleccion;
    let cantidad = l.cantidad;
    const opcionesBase = [
      ...(p.guarnicion_base_id ? [guarPorId.get(p.guarnicion_base_id) || { id: p.guarnicion_base_id, nombre: p.guarnicion_base }] : []),
      ...guarniciones.filter((g) => g.id !== p.guarnicion_base_id),
    ];
    const htmlGuarnicion = p.tipo !== 'bebidas' ? `
      <div><div class="etiqueta-campo">Guarnición (${p.guarnicion_base_id ? `por defecto: ${esc(p.guarnicion_base)}` : 'opcional'})</div>
        <div class="opciones">${opcionesBase
          .map((g) => `<button type="button" class="chip ${g.id === base ? 'activo' : ''}" data-base="${g.id}">${esc(g.nombre)}</button>`)
          .join('')}<button type="button" class="chip ${!base ? 'activo' : ''}" data-base="">Sin guarnición</button></div></div>
      ${p.con_eleccion && opcionesEleccion.length
        ? `<div><div class="etiqueta-campo">Guarnición a elección (de hoy)</div>
           <div class="opciones">${opcionesEleccion
             .map((g) => `<button type="button" class="chip ${g.id === eleccion ? 'activo' : ''}" data-eleccion="${g.id}">${esc(g.nombre)}</button>`)
             .join('')}<button type="button" class="chip ${idx != null && !eleccion ? 'activo' : ''}" data-eleccion="0">Ninguna</button></div></div>`
        : ''
      }` : '';
    const m = abrirModal(`
      <div class="pila">
        <div class="fila entre"><h3>${esc(p.nombre)}</h3><button class="btn chico" data-x>✕</button></div>
        <div class="suave">${p.tipo === 'menu' ? `Menú ${dinero(p.precio)} · incluye ${incluidoMenu.join(' + ').toLowerCase()}` : dinero(p.precio)}</div>
        ${htmlGuarnicion}
        <label class="campo"><span>Nota para cocina (opcional)</span>
          <input id="nota-plato" value="${esc(l.nota)}" placeholder="Ej: bien cocido, sin cebolla" maxlength="150" autocomplete="off"></label>
        <div class="fila entre">
          <span class="etiqueta-campo">Cantidad</span>
          <div class="contador-cant"><button type="button" id="menos">−</button><span class="v" id="cant">${cantidad}</span><button type="button" class="mas" id="mas">＋</button></div>
        </div>
        <div class="error" data-err></div>
        <div class="fila">
          ${idx != null ? '<button type="button" class="btn peligro" id="quitar">Quitar</button>' : ''}
          <button type="button" class="btn primario crecer" id="ok">${idx != null ? 'Guardar' : 'Agregar al pedido'}</button>
        </div>
      </div>`);
    let eleccionTocada = idx != null;
    $('[data-x]', m).onclick = cerrarModal;
    $$('[data-base]', m).forEach(
      (x) =>
        (x.onclick = () => {
          base = x.dataset.base ? Number(x.dataset.base) : null;
          $$('[data-base]', m).forEach((y) => y.classList.toggle('activo', y === x));
        })
    );
    $$('[data-eleccion]', m).forEach(
      (x) =>
        (x.onclick = () => {
          eleccion = Number(x.dataset.eleccion) || null;
          eleccionTocada = true;
          $$('[data-eleccion]', m).forEach((y) => y.classList.toggle('activo', y === x));
        })
    );
    $('#menos', m).onclick = () => ($('#cant', m).textContent = cantidad = Math.max(1, cantidad - 1));
    $('#mas', m).onclick = () => ($('#cant', m).textContent = cantidad = Math.min(99, cantidad + 1));
    if (idx != null)
      $('#quitar', m).onclick = () => {
        b.lineas.splice(idx, 1);
        cerrarModal();
        refrescar();
      };
    $('#ok', m).onclick = () => {
      if (p.con_eleccion && !eleccionTocada) {
        $('[data-err]', m).textContent = 'Elija la guarnición a elección (o "Ninguna")';
        return;
      }
      const nueva = { producto_id: p.id, cantidad, nota: $('#nota-plato', m).value.trim(), base, eleccion };
      if (idx != null) b.lineas.splice(idx, 1);
      agregarLinea(nueva);
      cerrarModal();
      refrescar();
    };
  }

  // Carta (pestaña) y categoría elegidas en el panel izquierdo
  let pestana = carta.menu.length ? 'menu' : carta.extras.length ? 'extra' : 'bebidas';
  let categoria = 'todos';
  let busqueda = '';
  const mesaSel = () => mesas.find((m) => m.id === b.mesa_id);
  const vendible = (p) => (b.tipo === 'local' ? p.para_local : p.para_llevar);

  function tarjetaPlato(p) {
    const n = cantidadDe(p.id);
    const guar = p.tipo !== 'bebidas' ? [p.guarnicion_base ? `con ${p.guarnicion_base.toLowerCase()}` : '', p.con_eleccion ? '+ a elección' : ''].filter(Boolean).join(' ') : '';
    return `
      <button type="button" class="plato ${!p.disponible ? 'sin-stock' : ''}" data-mas="${p.id}" data-pid="${p.id}" ${!p.disponible ? 'disabled' : ''}>
        <span class="cuenta ${n ? '' : 'oculto'}">${n}</span>
        <span class="fila entre"><b>${esc(p.nombre)}</b>${!p.disponible ? '<span class="insignia no">Agotado</span>' : ''}</span>
        <small class="suave desc">${esc(p.descripcion)}</small>
        <span class="pie"><b class="precio">${p.tipo === 'menu' ? '' : dinero(p.precio)}</b><small class="suave">${esc(guar)}</small></span>
      </button>`;
  }

  function pintarCarta() {
    const deCarta = (pestana === 'menu' ? carta.menu : pestana === 'bebidas' ? (carta.bebidas || []) : carta.extras).filter(vendible);
    const cats = [...new Set(deCarta.map((p) => p.categoria || 'Otros'))];
    if (!cats.includes(categoria)) categoria = 'todos';
    const q = busqueda.toLowerCase();
    const lista = deCarta.filter(
      (p) => (categoria === 'todos' || (p.categoria || 'Otros') === categoria) && (!q || (p.nombre + ' ' + p.descripcion).toLowerCase().includes(q))
    );
    $$('[data-pestana]', main).forEach((x) => x.classList.toggle('activo', x.dataset.pestana === pestana));
    $('#cats', main).innerHTML =
      cats.length > 1
        ? [['todos', 'Todos'], ...cats.map((c) => [c, c])]
            .map(([v, t]) => `<button type="button" class="chip chico ${v === categoria ? 'activo' : ''}" data-cat="${esc(v)}">${esc(t)}</button>`)
            .join('')
        : '';
    $('#grid', main).innerHTML =
      (pestana === 'menu' && carta.sopa && carta.menu.length
        ? `<div class="suave" style="grid-column:1/-1">🍲 Menú <b>${dinero(carta.precio_menu)}</b> · ${incluidoMenu.join(' · ')} — elija el segundo</div>`
        : '') +
        lista.map(tarjetaPlato).join('') ||
      `<div class="vacio">${pestana === 'menu' && !carta.menu.length ? 'No hay menú del día cargado para hoy.' : 'Sin platos.'}</div>`;
    $$('[data-cat]', main).forEach((x) => (x.onclick = () => ((categoria = x.dataset.cat), pintarCarta())));
    $$('[data-mas]', main).forEach((x) => (x.onclick = () => configurarPlato(porId.get(Number(x.dataset.mas)))));
  }

  function htmlPedido() {
    if (!b.lineas.length) return '<div class="vacio">🍽️<br>Sin platos aún<br><small>Toque los platos de la carta</small></div>';
    return b.lineas
      .map((l, i) => {
        const p = porId.get(l.producto_id);
        const det = textoLinea(l);
        return `<div class="linea-pedido">
          <div class="info" data-editar-linea="${i}">
            <div class="nombre">${esc(p.nombre)}</div>
            ${det ? `<div class="guar">${det}</div>` : ''}
            ${l.nota ? `<div class="guar nota-item">📝 ${esc(l.nota)}</div>` : ''}
            <div class="suave peq">${dinero(p.precio * l.cantidad)} · tocar para cambiar</div>
          </div>
          <div class="contador-cant"><button type="button" data-l-menos="${i}">−</button><span class="v">${l.cantidad}</span><button type="button" class="mas" data-l-mas="${i}">＋</button></div>
        </div>`;
      })
      .join('');
  }

  function refrescar() {
    $('#pedido', main).innerHTML = htmlPedido();
    $('#cant-pedido', main).textContent = `${cantidadTotal()} plato(s)`;
    $$('[data-total]', main).forEach((x) => (x.textContent = dinero(total())));
    $$('.plato', main).forEach((f) => {
      const n = cantidadDe(Number(f.dataset.pid));
      const c = $('.cuenta', f);
      c.textContent = n;
      c.classList.toggle('oculto', !n);
    });
    enlazarPedido();
  }

  function enlazarPedido() {
    $$('[data-l-menos]', main).forEach(
      (x) =>
        (x.onclick = () => {
          const l = b.lineas[Number(x.dataset.lMenos)];
          l.cantidad -= 1;
          if (l.cantidad <= 0) b.lineas.splice(Number(x.dataset.lMenos), 1);
          refrescar();
        })
    );
    $$('[data-l-mas]', main).forEach(
      (x) =>
        (x.onclick = () => {
          const l = b.lineas[Number(x.dataset.lMas)];
          l.cantidad = Math.min(99, l.cantidad + 1);
          refrescar();
        })
    );
    $$('[data-editar-linea]', main).forEach(
      (x) =>
        (x.onclick = () => {
          const i = Number(x.dataset.editarLinea);
          configurarPlato(porId.get(b.lineas[i].producto_id), i);
        })
    );
  }

  // Selector de atención: solo si la mesa ya tiene alguna abierta
  function htmlAtencion() {
    const as = atencionesDe(b.mesa_id);
    if (!as.length) return '';
    const opt = (v, t) => `<option value="${v}" ${String(b.atencion) === String(v) ? 'selected' : ''}>${t}</option>`;
    return `<select class="entrada" id="atencion" aria-label="Atención">
      ${as.length > 1 && !b.atencion ? opt('', '— ¿A qué atención va? —') : ''}
      ${as
        .map((cs) => {
          const c = cs[0];
          const t = `Atención #${c.atencion_numero} · ${cs.length} comanda(s) · ${dinero(cs.reduce((s, x) => s + porCobrarDe(x), 0))}${c.mozo_nombre ? ` · ${esc(c.mozo_nombre)}` : ''}`;
          return opt(c.atencion_id, t);
        })
        .join('')}
      ${opt('nueva', '＋ Nueva atención (otro cliente)')}
    </select>`;
  }

  function render() {
    const m = mesaSel();
    const titulo = b.tipo === 'llevar' ? 'Para llevar' : m ? `Mesa ${esc(m.etiqueta)}` : 'Elija una mesa';
    const sub =
      b.tipo === 'local' && m ? [m.piso, m.zona].filter(Boolean).map(esc).join(' · ') : editando ? `Comanda #${existente.numero_dia}` : 'Nueva comanda';
    const ordenMesas = mesas;
    main.innerHTML = `
      <div class="editor">
        <div class="editor-cab">
          <button class="btn chico" data-accion="volver">${svg('<path d="m15 18-6-6 6-6"/>', 16)} Volver</button>
          <div class="editor-titulo"><b class="titulo">${titulo}</b> <span class="suave">· ${sub}</span></div>
          <div class="segmento compacto">
            <button type="button" data-tipo="local" class="${b.tipo === 'local' ? 'activo' : ''}">🍽️ En mesa</button>
            <button type="button" data-tipo="llevar" class="${b.tipo === 'llevar' ? 'activo' : ''}">🥡 Para llevar</button>
          </div>
          <b class="total-cab">Total: <span data-total>${dinero(total())}</span></b>
        </div>
        <div class="editor-cuerpo">
          <section class="editor-carta">
            <div class="pestanas">
              <button type="button" data-pestana="menu">Menú del día</button>
              <button type="button" data-pestana="extra">Extras</button>
              <button type="button" data-pestana="bebidas">Bebidas</button>
            </div>
            <div class="fila envolver">
              <input class="entrada" id="buscar" type="search" placeholder="🔎 Buscar plato…" autocomplete="off" value="${esc(busqueda)}" style="max-width:240px">
              <div class="fila envolver" id="cats"></div>
            </div>
            <div class="grid-platos" id="grid"></div>
          </section>
          <aside class="editor-pedido tarjeta">
            <div class="fila entre"><b>Comanda — ${titulo}</b><small class="suave" id="cant-pedido">${cantidadTotal()} plato(s)</small></div>
            ${
              b.tipo === 'local'
                ? `<select class="entrada" id="mesa" aria-label="Mesa">
                    <option value="">— Elegir mesa —</option>
                    ${ordenMesas
                      .map(
                        (x) =>
                          `<option value="${x.id}" ${x.id === b.mesa_id ? 'selected' : ''}>Mesa ${esc(x.etiqueta)} · ${esc(x.piso || '')} · ${x.ocupada ? 'ocupada' : 'libre'}</option>`
                      )
                      .join('')}
                  </select>`
                : `<input class="entrada" id="cliente" value="${esc(b.cliente)}" placeholder="Nombre del cliente / referencia" autocomplete="off">`
            }
            ${b.tipo === 'local' ? htmlAtencion() : ''}
            <div id="pedido" class="lista-pedido">${htmlPedido()}</div>
            <textarea class="entrada" id="nota" rows="2" placeholder="Nota general para cocina (ej: alérgico al maní)">${esc(b.nota)}</textarea>
            <div class="fila entre total-pedido"><span>Total</span><b data-total>${dinero(total())}</b></div>
            <div class="fila acciones-pedido">
              <button class="btn" id="guardar">Guardar</button>
              ${puede('admin', 'mozo', 'caja') ? '<button class="btn acento" id="precuenta" aria-label="Precuenta">🧾<span class="solo-ancho"> Precuenta</span></button>' : ''}
              ${b.estadoOriginal === 'generado' ? `<button class="btn primario crecer" id="enviar">${svg('<path d="m22 2-7 20-4-9-9-4Z M22 2 11 13"/>', 18)} Enviar a cocina</button>` : ''}
            </div>
          </aside>
        </div>
      </div>`;
    enlazar();
  }

  function enlazar() {
    $$('[data-tipo]', main).forEach(
      (el) =>
        (el.onclick = () => {
          b.tipo = el.dataset.tipo;
          b.lineas = b.lineas.filter((l) => vendible(porId.get(l.producto_id)));
          render();
        })
    );
    $$('[data-pestana]', main).forEach((x) => (x.onclick = () => ((pestana = x.dataset.pestana), (categoria = 'todos'), pintarCarta())));
    const mesa = $('#mesa', main);
    if (mesa)
      mesa.onchange = () => {
        b.mesa_id = Number(mesa.value) || null;
        b.atencion = atencionPorDefecto(b.mesa_id);
        render();
      };
    const at = $('#atencion', main);
    if (at) at.onchange = () => (b.atencion = at.value === 'nueva' ? 'nueva' : Number(at.value) || null);
    const cli = $('#cliente', main);
    if (cli) cli.oninput = () => (b.cliente = cli.value);
    $('#nota', main).oninput = (e) => (b.nota = e.target.value);
    $('#buscar', main).oninput = (e) => {
      busqueda = e.target.value.trim();
      pintarCarta();
    };
    $('#guardar', main).onclick = () => guardar(false);
    const env = $('#enviar', main);
    if (env) env.onclick = () => guardar(true);
    const pc = $('#precuenta', main);
    if (pc) pc.onclick = precuenta;
    pintarCarta();
    enlazarPedido();
  }

  // La precuenta sale de lo guardado: de la atención entera, o de esta comanda si es para llevar
  async function precuenta() {
    if (JSON.stringify(b.lineas) !== lineasGuardadas) return toast('Guarde los cambios antes de imprimir la precuenta', 'error');
    const ventana = usaTicketeraCaja() ? null : prepararVentana(); // antes del await, para que el celular no bloquee la ventana
    try {
      // de toda la atención (lo pendiente), o de esta comanda si no tiene
      const atencionId = typeof b.atencion === 'number' ? b.atencion : existente?.atencion_id;
      const ids = atencionId
        ? (await api('GET', '/api/comandas?vista=por_cobrar')).filter((c) => c.atencion_id === atencionId).map((c) => c.id)
        : b.id ? [b.id] : [];
      if (!ids.length) throw new Error('Todavía no hay comandas guardadas para la precuenta');
      precuentaDe(ids, ventana);
    } catch (e) {
      ventana?.close();
      toast(e.message, 'error');
    }
  }

  async function guardar(enviar) {
    if (b.tipo === 'local' && !b.mesa_id) return toast('Seleccione una mesa', 'error');
    if (b.tipo === 'local' && !b.atencion && atencionesDe(b.mesa_id).length > 1) return toast('Elija a qué atención va la comanda', 'error');
    if (!b.lineas.length) return toast('Agregue al menos un plato', 'error');
    const cuerpo = {
      tipo: b.tipo,
      mesa_id: b.tipo === 'local' ? b.mesa_id : null,
      atencion_id: b.tipo === 'local' && typeof b.atencion === 'number' ? b.atencion : null,
      nueva_atencion: b.tipo === 'local' && b.atencion === 'nueva',
      cliente: b.cliente,
      nota: b.nota,
      enviar,
      items: b.lineas.map((l) => ({
        producto_id: l.producto_id,
        cantidad: l.cantidad,
        nota: l.nota,
        guarnicion_base_id: l.base,
        guarnicion_eleccion_id: l.eleccion,
      })),
    };
    $$('.acciones-pedido button', main).forEach((x) => (x.disabled = true));
    try {
      const c = b.id ? await api('PUT', `/api/comandas/${b.id}`, cuerpo) : await api('POST', '/api/comandas', cuerpo);
      toast(enviar ? `Comanda #${c.numero_dia} enviada a cocina` : `Comanda #${c.numero_dia} guardada`, 'ok');
      history.replaceState(null, '', '#/comandas');
      navegar();
    } catch (e) {
      toast(e.message, 'error', 4000);
      $$('.acciones-pedido button', main).forEach((x) => (x.disabled = false));
    }
  }

  render();
}

// ---------- Tickets de cocina (estación de impresión) ----------
function leerAuto() {
  try {
    return localStorage.getItem('impresion-auto') === '1';
  } catch {
    return false;
  }
}
function guardarAuto(v) {
  try {
    localStorage.setItem('impresion-auto', v ? '1' : '0');
  } catch {}
}

async function vTickets(main) {
  const lista = (await api('GET', '/api/comandas?vista=cocina')).sort((a, c) =>
    String(a.enviado_en || a.creado_en).localeCompare(String(c.enviado_en || c.creado_en))
  );
  const pendientes = lista.filter((c) => !c.ticket_impreso);
  const impresos = lista.filter((c) => c.ticket_impreso).reverse();
  const tq = S.ticketera?.activa;
  const auto = !tq && leerAuto() && imprimeDirecto();
  const panelCola = tq ? await panelTicketera() : '';
  const ticket = (c) => `
    <div class="tarjeta ticket-prev ${c.ticket_impreso ? 'impreso' : ''}">
      <div class="fila entre"><span class="num">#${c.numero_dia} · ${lugar(c)}</span>
        <span class="tiempo" data-desde="${esc(c.enviado_en || c.creado_en)}"></span></div>
      <div class="suave peq">${esc(c.mozo_nombre || '')} · enviado ${hora(c.enviado_en)} ${c.ticket_modificado ? '· <b>MODIFICADA</b>' : ''}</div>
      <ul class="items">${c.items.map(lineaItem).join('')}</ul>
      ${c.nota ? `<div class="nota">📝 ${esc(c.nota)}</div>` : ''}
      <div class="acciones">
        <button class="btn chico ${c.ticket_impreso ? '' : 'primario'}" data-accion="imprimir-ticket" data-ids="${c.id}">🖨️ ${c.ticket_impreso ? 'Reimprimir' : 'Imprimir'}</button>
        <button class="btn chico" data-accion="ver-comanda" data-id="${c.id}">Ver</button>
      </div>
    </div>`;
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre envolver"><h2>Tickets de cocina</h2>
        ${pendientes.length ? `<button class="btn primario" data-accion="imprimir-ticket" data-ids="${pendientes.map((c) => c.id).join(',')}">🖨️ Imprimir ${pendientes.length} pendiente(s)</button>` : ''}</div>
      ${panelCola}
      ${
        tq
          ? ''
          : imprimeDirecto()
          ? `<label class="check tarjeta"><input type="checkbox" id="auto" ${auto ? 'checked' : ''}>
              Imprimir automáticamente cada ticket nuevo (deje esta pantalla abierta en la PC de la impresora)</label>`
          : '<div class="tarjeta suave peq">Al imprimir se abre el PDF del ticket: use la opción Imprimir del navegador. Para imprimir con un toque, use Chrome o Edge en la computadora de la impresora.</div>'
      }
      <h3>${tq ? 'En cola de la ticketera' : 'Por imprimir'} (${pendientes.length})</h3>
      ${pendientes.length ? `<div class="grid">${pendientes.map(ticket).join('')}</div>` : '<div class="vacio">No hay tickets pendientes. 👍</div>'}
      <h3>En cocina · ya impresos (${impresos.length})</h3>
      ${impresos.length ? `<div class="grid">${impresos.map(ticket).join('')}</div>` : '<div class="suave">Ninguno.</div>'}
    </div>`;
  const chk = $('#auto', main);
  if (chk) chk.onchange = () => guardarAuto(chk.checked);
  enlazarPanelTicketera(main);
  const tick = () =>
    $$('[data-desde]', main).forEach((el) => {
      const m = minutosDesde(el.dataset.desde);
      el.textContent = `⏱ ${m} min`;
      el.classList.toggle('alerta', m >= 20);
    });
  tick();
  S.timers.forEach(clearInterval);
  S.timers = [setInterval(tick, 20000)];
  // impresión automática de los pendientes
  if (auto && pendientes.length) {
    const ids = pendientes.map((c) => c.id);
    imprimirPDF(`/api/tickets.pdf?ids=${ids.join(',')}`);
    try {
      await api('POST', '/api/tickets/impresos', { ids });
    } catch {}
  }
}

// ---------- Cola de la ticketera (en la pantalla Tickets) ----------

async function panelTicketera() {
  const t = S.ticketera;
  let cola = [];
  if (puede('admin', 'caja')) {
    try {
      cola = (await api('GET', '/api/impresora')).cola.filter((x) => ['pendiente', 'error'].includes(x.estado));
    } catch {}
  }
  const estado = t.errores
    ? `<b class="error-txt">⚠️ La ticketera no responde.</b> ${esc(t.ultimoError || '')}<br><span class="suave peq">Se reintenta sola cada pocos segundos. Revise que esté encendida, con papel y conectada.</span>`
    : t.pendientes
    ? `🖨️ Imprimiendo… ${t.pendientes} en cola`
    : `✅ Ticketera lista. ${t.autoComandas ? 'Las comandas se imprimen solas al enviarse a cocina.' : 'Las comandas se imprimen al tocar "Imprimir".'}`;
  return `<div class="tarjeta panel-ticketera ${t.errores ? 'falla' : ''}">
      <div class="fila entre envolver"><div>${estado}</div>
        <div class="fila">${t.errores ? '<button class="btn chico primario" data-tq="reintentar">Reintentar ahora</button>' : ''}
        ${puede('admin', 'caja') ? '<button class="btn chico" data-tq="prueba">Imprimir prueba</button>' : ''}</div></div>
      ${
        cola.length
          ? `<ul class="cola-impresion">${cola
              .map(
                (x) => `<li class="${x.estado}"><span>${esc(x.titulo)}
                  <small class="suave">${hora(x.creado_en)}${x.intentos ? ` · ${x.intentos} intento(s)` : ''}</small></span>
                  <button class="btn chico" data-tq-cancelar="${x.id}" title="Quitar de la cola">Quitar</button></li>`
              )
              .join('')}</ul>`
          : ''
      }
    </div>`;
}

function enlazarPanelTicketera(cont) {
  const b = $('[data-tq="reintentar"]', cont);
  if (b) b.onclick = () => api('POST', '/api/impresora/reintentar', {}).catch((e) => toast(e.message, 'error'));
  const p = $('[data-tq="prueba"]', cont);
  if (p) p.onclick = () => aTicketera('/api/impresora/prueba', {}, 'Ticket de prueba enviado');
  $$('[data-tq-cancelar]', cont).forEach(
    (x) =>
      (x.onclick = async () => {
        if (!(await confirmar('¿Quitar este ticket de la cola? No se imprimirá.', { ok: 'Quitar', peligro: true }))) return;
        api('POST', '/api/impresora/cancelar', { id: Number(x.dataset.tqCancelar) }).catch((e) => toast(e.message, 'error'));
      })
  );
}

// ---------- Comprobantes SUNAT ----------
// Flujo: se cobra como "boleta o factura", se emite en SOL, se descarga el XML y se sube aquí:
// el sistema lo vincula con su cobro y lo imprime.
function imprimirSunat(id, ventana) {
  if (usaTicketeraCaja()) return aTicketera('/api/imprimir/sunat', { id }, 'Comprobante enviado a la ticketera');
  imprimirPDF(`/api/sunat/${id}/comprobante.pdf`, ventana);
}

/** Después de subir un XML sin gesto del usuario: con ticketera o Chrome se imprime solo; si no, se ofrece abrir el PDF */
function imprimirTrasSubir(comp) {
  if (usaTicketeraCaja() || imprimeDirecto()) return imprimirSunat(comp.id);
  const m = abrirModal(`<div class="pila"><h3>${esc(comp.serie)}-${esc(comp.numero)} listo</h3>
    <button class="btn primario bloque" id="abrir-pdf">🖨️ Abrir para imprimir</button>
    <button class="btn bloque" data-x>Cerrar</button></div>`);
  $('#abrir-pdf', m).onclick = () => (cerrarModal(), imprimirPDF(`/api/sunat/${comp.id}/comprobante.pdf`));
  $('[data-x]', m).onclick = cerrarModal;
}

const leerArchivo = (f) =>
  new Promise((ok, mal) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1] || '');
    r.onerror = () => mal(new Error('No se pudo leer el archivo'));
    r.readAsDataURL(f);
  });

async function subirXML(archivo, cobroId) {
  if (!archivo) return;
  if (archivo.size > 700 * 1024) return toast('El archivo es demasiado grande para ser un XML de SUNAT', 'error');
  try {
    const r = await api('POST', '/api/sunat/xml', { nombre: archivo.name, contenido: await leerArchivo(archivo), cobro_id: cobroId || null });
    r.avisos.forEach((a) => toast(`⚠️ ${a}`, 'error', 7000));
    const nombre = `${r.resumen.tipo.toLowerCase().startsWith('factura') ? 'Factura' : 'Boleta'} ${r.resumen.numero}`;
    if (r.cobro) {
      toast(`✅ ${nombre} vinculada a ${r.cobro.lugar || 'su cobro'} (${r.cobro.comandas || ''})`, 'ok', 4000);
      imprimirTrasSubir(r.comprobante);
    } else if (r.candidatos.length) elegirCobro(r.comprobante, r.candidatos, nombre);
    else {
      toast(`${nombre} guardada, pero no hay un cobro pendiente con el mismo total (${dinero(r.resumen.total)}). Puede vincularla después.`, 'error', 7000);
      imprimirTrasSubir(r.comprobante);
    }
    recargarVista();
  } catch (e) {
    toast(e.message, 'error', 6000);
  }
}

/** Varios cobros con el mismo total: el usuario elige a cuál corresponde */
function elegirCobro(comp, candidatos, nombre) {
  const m = abrirModal(`<div class="pila">
    <h3>¿A qué cobro corresponde la ${esc(nombre)}?</h3>
    <div class="suave">Hay ${candidatos.length} cobros pendientes con el mismo total.</div>
    ${candidatos
      .map((c) => `<button class="btn bloque" data-cobro="${c.id}">${esc(c.lugar || 'Cobro')} · ${esc(c.comandas || '')} · ${hora(c.creado_en)} · ${dinero(c.total)}</button>`)
      .join('')}
    <button class="btn bloque" data-cobro="">Ninguno (solo imprimir)</button></div>`);
  $$('[data-cobro]', m).forEach(
    (b) =>
      (b.onclick = async () => {
        cerrarModal();
        try {
          if (b.dataset.cobro) await api('POST', `/api/sunat/${comp.id}/vincular`, { cobro_id: Number(b.dataset.cobro) });
          imprimirTrasSubir(comp);
          recargarVista();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );
}

async function vComprobantes(main) {
  const fecha = S.fechaComprobantes || fechaHoy();
  const r = await api('GET', `/api/sunat?fecha=${fecha}`);
  const tipoTxt = (t) => (t === '01' ? 'Factura' : 'Boleta');
  const docTxt = { 1: 'DNI', 6: 'RUC', 4: 'C.E.', 7: 'Pas.' };
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre envolver"><h2>Comprobantes SUNAT</h2>
        <input type="date" class="entrada" id="fecha" value="${fecha}" max="${fechaHoy()}" style="width:auto"></div>
      <label class="tarjeta zona-xml" id="zona-xml">
        <input type="file" accept=".xml,.zip,text/xml,application/xml,application/zip" id="archivo-xml" hidden>
        <b>⬆️ Subir XML descargado de SUNAT</b>
        <span class="suave peq">Toque aquí o arrastre el archivo (.xml o .zip). Se vincula solo con su cobro y se imprime.</span>
      </label>

      <h3>Pendientes de comprobante (${r.pendientes.length})</h3>
      ${
        r.pendientes.length
          ? `<div class="grid">${r.pendientes
              .map(
                (c) => `<div class="tarjeta pila">
                  <div class="fila entre"><b>${esc(c.lugar || 'Cobro')}</b><b>${dinero(c.total)}</b></div>
                  <div class="suave peq">Comandas ${esc(c.comandas || '-')} · ${esc(c.metodo)} · cobrado ${hora(c.creado_en)}</div>
                  <div class="fila">
                    <button class="btn chico crecer" data-datos-sol="${c.id}">📋 Datos para SOL</button>
                    <button class="btn chico primario crecer" data-subir="${c.id}">⬆️ Subir XML</button>
                  </div></div>`
              )
              .join('')}</div>`
          : '<div class="suave">No hay cobros esperando boleta o factura.</div>'
      }

      <h3>Emitidos (${r.comprobantes.length})</h3>
      ${
        r.comprobantes.length
          ? `<div class="tarjeta"><ul class="cola-impresion">${r.comprobantes
              .map(
                (c) => `<li><span><b>${tipoTxt(c.tipo)} ${esc(c.serie)}-${esc(c.numero)}</b> · ${dinero(c.total)}
                  <small class="suave">${c.cliente_doc && c.cliente_doc !== '-' ? `${docTxt[c.cliente_tipo_doc] || 'Doc.'} ${esc(c.cliente_doc)} · ` : ''}${esc(c.cliente_nombre || '')}
                  · ${c.cobro_id ? `comandas ${esc(c.comandas || '')}${c.cobro_anulado ? ' (cobro anulado)' : ''}` : '<b>sin vincular a un cobro</b>'}</small></span>
                  <span class="fila">
                    ${c.cobro_id ? '' : `<button class="btn chico" data-vincular="${c.id}" data-total="${c.total}">Vincular</button>`}
                    <button class="btn chico primario" data-accion="imprimir-sunat" data-id="${c.id}">Imprimir</button>
                    <a class="btn chico" href="/api/sunat/${c.id}/comprobante.pdf" target="_blank" rel="noopener">PDF</a>
                    <a class="btn chico" href="/api/sunat/${c.id}/xml">XML</a>
                    ${puede('admin') ? `<button class="btn chico peligro" data-borrar="${c.id}" aria-label="Eliminar">🗑</button>` : ''}
                  </span></li>`
              )
              .join('')}</ul></div>`
          : '<div class="suave">Todavía no se subió ningún comprobante este día.</div>'
      }
    </div>`;

  $('#fecha', main).onchange = (e) => {
    S.fechaComprobantes = e.target.value || null;
    vComprobantes(main);
  };
  const input = $('#archivo-xml', main);
  let destino = null; // cobro al que se sube el XML (si se eligió uno)
  input.onchange = () => {
    subirXML(input.files[0], destino);
    input.value = '';
    destino = null;
  };
  const zona = $('#zona-xml', main);
  zona.ondragover = (e) => (e.preventDefault(), zona.classList.add('encima'));
  zona.ondragleave = () => zona.classList.remove('encima');
  zona.ondrop = (e) => {
    e.preventDefault();
    zona.classList.remove('encima');
    subirXML(e.dataTransfer.files[0], null);
  };
  $$('[data-subir]', main).forEach(
    (b) =>
      (b.onclick = () => {
        destino = Number(b.dataset.subir);
        input.click();
      })
  );
  $$('[data-datos-sol]', main).forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          const { cobro, comandas } = await api('GET', `/api/sunat/cobro/${b.dataset.datosSol}`);
          const m = abrirModal(`<div class="pila">
            <div class="fila entre"><h3>Datos para SOL · ${esc(cobro.lugar || '')}</h3><button class="btn chico" data-x>✕</button></div>
            ${detalleSunat(comandas, cobro.total)}</div>`);
          $('[data-x]', m).onclick = cerrarModal;
          $$('[data-copiar]', m).forEach((x) => (x.onclick = () => copiar(x.dataset.copiar)));
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );
  $$('[data-vincular]', main).forEach(
    (b) =>
      (b.onclick = () => {
        const cands = r.pendientes.filter((p) => Math.abs(p.total - Number(b.dataset.total)) < 0.01);
        const lista = cands.length ? cands : r.pendientes;
        if (!lista.length) return toast('No hay cobros pendientes de comprobante este día', 'error');
        elegirCobro({ id: Number(b.dataset.vincular) }, lista, 'comprobante');
      })
  );
  $$('[data-borrar]', main).forEach(
    (b) =>
      (b.onclick = async () => {
        if (!(await confirmar('¿Eliminar este comprobante del sistema? (No lo anula en SUNAT)', { ok: 'Eliminar', peligro: true }))) return;
        try {
          await api('DELETE', `/api/sunat/${b.dataset.borrar}`);
          recargarVista();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );
}

// ---------- Mesas ----------
const EXCEDIDO_MIN = 120;
const duracion = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);
const estadoMesa = (m) => (!m.ocupada ? 'libre' : m.por_entregar ? 'ocupada' : 'cobrar');
// Posición en el plano: unidades donde el ancho del nivel mide 100 (alto del nivel = H)
const enPlano = (o, H) => `left:${o.x}%;top:${(o.y / H) * 100}%;width:${o.ancho}%;height:${(o.alto / H) * 100}%`;

async function vMesas(main) {
  const [mesas, comandas, plano] = await Promise.all([
    api('GET', '/api/mesas'),
    api('GET', '/api/comandas?vista=por_cobrar'),
    api('GET', '/api/plano'),
  ]);
  const activas = mesas.filter((m) => m.activa);
  const porId = new Map(activas.map((m) => [m.id, m]));
  const principal = (m) => porId.get(m.principal_id) || m;
  const pisos = [...new Set(activas.map((m) => m.piso))];
  if (!pisos.includes(S.salonPiso)) S.salonPiso = pisos[0];
  const modo = S.salonModo || 'mapa';
  const editar = puede('admin') && S.salonEditar;
  const unir = S.salonUnir; // Set de ids mientras se eligen mesas para unir
  const delPiso = activas.filter((m) => m.piso === S.salonPiso);
  const elementos = plano.elementos.filter((e) => e.piso === S.salonPiso);
  const H = Math.max(60, ...[...delPiso, ...elementos].map((o) => o.y + o.alto)) + 6;
  const principales = delPiso.filter((m) => m.principal_id === m.id);
  const cuenta = (e) => principales.filter((m) => estadoMesa(m) === e).length;
  const excedidas = activas
    .filter((m) => m.principal_id === m.id && m.ocupada && minutosDesde(m.ocupada_desde) >= EXCEDIDO_MIN)
    .sort((a, b) => a.ocupada_desde.localeCompare(b.ocupada_desde));
  const llevar = comandas.filter((c) => c.tipo === 'llevar');

  const htmlMesa = (m) => {
    const p = principal(m);
    const min = p.ocupada ? minutosDesde(p.ocupada_desde) : 0;
    const mostrarDatos = m.id === p.id && p.ocupada;
    return `<button class="mesa-p ${estadoMesa(p)}${min >= EXCEDIDO_MIN ? ' excedida' : ''}${unir?.has(m.id) ? ' sel' : ''}"
        data-m="${m.id}" style="${enPlano(m, H)}"
        title="Mesa ${esc(m.etiqueta)} · ${esc(m.piso)}">
      <b>${esc(m.numero)}</b>
      ${mostrarDatos ? `<small>${dinero(p.por_cobrar)}</small><small class="t">${min >= EXCEDIDO_MIN ? '⚠ ' : ''}${duracion(min)}</small>` : ''}
    </button>`;
  };
  // Contorno y nombre ("10-11") de cada grupo de mesas unidas
  const htmlUniones = () =>
    principales
      .map((p) => {
        const g = delPiso.filter((m) => m.principal_id === p.id);
        if (g.length < 2) return '';
        const x = Math.min(...g.map((m) => m.x)) - 1;
        const y = Math.min(...g.map((m) => m.y)) - 1;
        const ancho = Math.max(...g.map((m) => m.x + m.ancho)) + 1 - x;
        const alto = Math.max(...g.map((m) => m.y + m.alto)) + 1 - y;
        return `<div class="union" style="${enPlano({ x, y, ancho, alto }, H)}"><span>${esc(p.etiqueta)}</span></div>`;
      })
      .join('');

  const barraModo = editar
    ? `<div class="aviso-modo"><b>Editando plano de ${esc(S.salonPiso)}:</b> arrastre las mesas y elementos. Toque una mesa y use "Girar" para cambiarla de horizontal a vertical.
        <div class="fila"><button class="btn chico" id="girar" disabled>⟳ Girar</button><button class="btn chico" id="cancelar-modo">Cancelar</button><button class="btn chico primario" id="guardar-plano">Guardar plano</button></div></div>`
    : unir
      ? `<div class="aviso-modo"><b>Unir mesas:</b> toque las mesas que se van a juntar (${unir.size} elegidas).
          <div class="fila"><button class="btn chico" id="cancelar-modo">Cancelar</button><button class="btn chico primario" id="confirmar-unir" ${unir.size < 2 ? 'disabled' : ''}>Unir ${esc(
            [...unir].map((id) => porId.get(id)?.numero).sort((a, b) => a - b).join('-')
          )}</button></div></div>`
      : '';

  main.innerHTML = `
    <div class="salon">
      <div class="salon-barra">
        <div class="segmento compacto">
          <button data-modo="mapa" class="${modo === 'mapa' ? 'activo' : ''}">Mapa de mesas</button>
          <button data-modo="llevar" class="${modo === 'llevar' ? 'activo' : ''}">🥡 Para llevar${llevar.length ? ` (${llevar.length})` : ''}</button>
        </div>
        ${
          modo === 'mapa'
            ? `${pisos.length > 1 ? `<div class="segmento compacto">${pisos.map((p) => `<button data-piso="${esc(p)}" class="${p === S.salonPiso ? 'activo' : ''}">${esc(p)}</button>`).join('')}</div>` : ''}
              ${!editar && !unir ? '<button class="btn chico" id="modo-unir">🔗 Unir mesas</button>' : ''}
              ${puede('admin') && !editar && !unir ? '<button class="btn chico" id="modo-editar">✏️ Editar plano</button>' : ''}
              <div class="conteos"><span class="libre">Libre ${cuenta('libre')}</span><span class="ocupada">Ocupada ${cuenta('ocupada')}</span><span class="cobrar">Por cobrar ${cuenta('cobrar')}</span></div>`
            : ''
        }
      </div>
      ${
        modo === 'llevar'
          ? `<div class="pila">
              <button class="btn primario" onclick="ir('#/nueva?tipo=llevar')">＋ Nuevo pedido para llevar</button>
              ${llevar.length ? `<div class="grid">${llevar.map(tarjetaComanda).join('')}</div>` : '<div class="vacio">No hay pedidos para llevar pendientes.</div>'}
            </div>`
          : `${barraModo}
            <div class="salon-cuerpo">
              <div class="plano-nivel${editar ? ' editando' : ''}${unir ? ' uniendo' : ''}" style="aspect-ratio:100/${H}">
                ${elementos.map((e) => `<div class="elem ${e.tipo}" data-e="${e.id}" style="${enPlano(e, H)}"><span>${esc(e.nombre)}</span></div>`).join('')}
                ${editar ? '' : htmlUniones()}
                ${delPiso.map(htmlMesa).join('') || '<div class="vacio">No hay mesas en este nivel.</div>'}
              </div>
              <aside class="excedidas">
                <h4>⚠ Tiempo excedido (${excedidas.length})</h4>
                ${excedidas.map((m) => `<button class="tarjeta" data-m="${m.id}"><b>Mesa ${esc(m.etiqueta)}</b><small>${esc(m.piso)}</small><span class="t">${duracion(minutosDesde(m.ocupada_desde))}</span></button>`).join('') || `<div class="suave peq">Ninguna mesa pasa de ${EXCEDIDO_MIN} min.</div>`}
              </aside>
            </div>
            <div class="leyenda-salon">Leyenda: <span><i class="libre"></i>Libre</span><span><i class="ocupada"></i>Ocupada</span><span><i class="cobrar"></i>Por cobrar (todo entregado)</span><span><i class="excedida"></i>Tiempo excedido (+${EXCEDIDO_MIN} min)</span><span><i class="unidas"></i>Mesas unidas</span></div>`
      }
    </div>`;

  const otraVez = () => vMesas(main);
  $$('[data-modo]', main).forEach((b) => (b.onclick = () => ((S.salonModo = b.dataset.modo), (S.salonUnir = null), (S.salonEditar = false), otraVez())));
  $$('[data-piso]', main).forEach((b) => (b.onclick = () => ((S.salonPiso = b.dataset.piso), (S.salonUnir = unir && new Set()), otraVez())));
  const on = (sel, fn) => {
    const el = $(sel, main);
    if (el) el.onclick = fn;
  };
  on('#modo-unir', () => ((S.salonUnir = new Set()), otraVez()));
  on('#modo-editar', () => ((S.salonEditar = true), otraVez()));
  on('#cancelar-modo', () => ((S.salonUnir = null), (S.salonEditar = false), otraVez()));
  on('#confirmar-unir', async () => {
    try {
      const r = await api('POST', '/api/mesas/unir', { ids: [...unir] });
      S.salonUnir = null;
      toast(`Mesas unidas: ${r.etiqueta}`, 'ok');
      otraVez();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  // mientras se edita o se eligen mesas, no se recarga en vivo (se perdería lo que se está haciendo)
  S.vista.escucha = editar || unir ? [] : ['mesas', 'comandas'];
  S.timers.forEach(clearInterval);
  S.timers = editar || unir ? [] : [setInterval(() => recargarVista(), 60000)]; // ponytail: refresca los minutos cada 60 s

  if (editar) return editarPlano(main, H, otraVez);

  $$('[data-m]', main).forEach(
    (el) =>
      (el.onclick = () => {
        const m = porId.get(Number(el.dataset.m));
        if (unir) {
          // se elige/quita la mesa (y todo su grupo, si ya estaba unida)
          const g = activas.filter((x) => x.principal_id === m.principal_id).map((x) => x.id);
          const quitar = unir.has(m.id);
          g.forEach((id) => (quitar ? unir.delete(id) : unir.add(id)));
          return otraVez();
        }
        const p = principal(m);
        const grupo = activas.filter((x) => x.principal_id === p.id);
        const cs = comandas.filter((c) => c.mesa_id === p.id);
        const separar = grupo.length > 1 ? `<button class="btn bloque" id="separar">✂️ Separar mesas ${esc(p.etiqueta)}</button>` : '';
        if (!cs.length && !separar) return ir(`#/nueva?mesa=${p.id}`);
        const total = cs.reduce((s, c) => s + porCobrarDe(c), 0);
        const atenciones = porAtencion(cs);
        // varias atenciones en la mesa (mesa compartida): también se puede cobrar todo junto
        const varias = atenciones.length > 1;
        const modal = abrirModal(`
          <div class="pila">
            <div class="fila entre"><h3>Mesa ${esc(p.etiqueta)} <span class="suave peq">· ${esc(p.piso)}</span></h3><button class="btn chico" data-x>✕</button></div>
            <div class="suave">${cs.length ? `Consumo: <b>${dinero(total)}</b>${varias ? ` · ${atenciones.length} atenciones` : ''}` : 'Libre'}</div>
            ${varias && puede('admin', 'caja') ? `<button class="btn acento bloque" id="cobrar-mesa">💵 Cobrar mesa completa (${dinero(total)})</button>` : ''}
            ${varias ? `<button class="btn bloque" id="precuenta-mesa">🧾 Precuenta de toda la mesa (${dinero(total)})</button>` : ''}
            ${atenciones.map((a) => bloqueAtencion(a, { mesa: true })).join('')}
            ${cs.length
              ? `<button class="btn bloque" data-accion="nueva-comanda" data-mesa="${p.id}" data-atencion="nueva">＋ Nueva atención (otro cliente en la mesa)</button>`
              : `<button class="btn primario bloque" data-accion="nueva-comanda" data-mesa="${p.id}">＋ Nueva comanda</button>`}
            ${separar}
          </div>`);
        $('[data-x]', modal).onclick = cerrarModal;
        const cm = $('#cobrar-mesa', modal);
        if (cm) cm.onclick = () => abrirCobro(pendientes(cs), `Cobrar mesa ${p.etiqueta}`);
        const pc = $('#precuenta-mesa', modal);
        if (pc) pc.onclick = () => precuentaDe(cs.map((c) => c.id));
        const sp = $('#separar', modal);
        if (sp)
          sp.onclick = async () => {
            try {
              await api('POST', `/api/mesas/${p.id}/separar`);
              cerrarModal();
              toast('Mesas separadas', 'ok');
            } catch (e) {
              toast(e.message, 'error');
            }
          };
      })
  );
}

// Modo edición del plano (admin): arrastrar mesas y elementos, girar mesas y guardar
function editarPlano(main, H, alTerminar) {
  const plano = $('.plano-nivel', main);
  const cambios = new Map(); // "m12" / "e3" -> { id, x, y, ancho, alto }
  let elegido = null;
  const datos = (el) => {
    const clave = el.dataset.m ? `m${el.dataset.m}` : `e${el.dataset.e}`;
    if (!cambios.has(clave)) {
      const st = el.style;
      cambios.set(clave, {
        id: Number(el.dataset.m || el.dataset.e),
        x: parseFloat(st.left),
        y: (parseFloat(st.top) * H) / 100,
        ancho: parseFloat(st.width),
        alto: (parseFloat(st.height) * H) / 100,
      });
    }
    return cambios.get(clave);
  };
  const pintar = (el, d) => (el.style.cssText = enPlano(d, H));
  const redondear = (v) => Math.round(v * 2) / 2; // se alinea a media unidad
  $$('.mesa-p, .elem', plano).forEach((el) => {
    el.onclick = null;
    el.onpointerdown = (ev) => {
      ev.preventDefault();
      if (elegido) elegido.classList.remove('elegido');
      elegido = el;
      el.classList.add('elegido');
      $('#girar', main).disabled = !el.dataset.m;
      const d = datos(el);
      const unidad = plano.getBoundingClientRect().width / 100; // px por unidad
      const inicio = { px: ev.clientX, py: ev.clientY, x: d.x, y: d.y };
      el.setPointerCapture(ev.pointerId);
      el.onpointermove = (e) => {
        d.x = redondear(Math.max(0, Math.min(100 - d.ancho, inicio.x + (e.clientX - inicio.px) / unidad)));
        d.y = redondear(Math.max(0, Math.min(H - d.alto, inicio.y + (e.clientY - inicio.py) / unidad)));
        pintar(el, d);
      };
      el.onpointerup = () => (el.onpointermove = null);
    };
  });
  $('#girar', main).onclick = () => {
    if (!elegido) return;
    const d = datos(elegido);
    [d.ancho, d.alto] = [d.alto, d.ancho];
    d.x = Math.min(d.x, 100 - d.ancho);
    pintar(elegido, d);
  };
  $('#guardar-plano', main).onclick = async () => {
    const lista = [...cambios.entries()];
    try {
      await api('PUT', '/api/plano', {
        mesas: lista.filter(([k]) => k[0] === 'm').map(([, v]) => v),
        elementos: lista.filter(([k]) => k[0] === 'e').map(([, v]) => v),
      });
      S.salonEditar = false;
      toast('Plano guardado', 'ok');
      alTerminar();
    } catch (e) {
      toast(e.message, 'error');
    }
  };
}

// ---------- Cartas: menú del día (cambia a diario) + extras (carta fija) ----------
async function vCarta(main) {
  const admin = puede('admin');
  const puedeAgotar = puede('admin', 'cocina', 'caja');
  const carta = await api('GET', `/api/carta${admin ? '?completo=1' : ''}`);
  const f = S.filtroCarta || 'todas';
  const todos = [...(carta.sopas || []), ...(carta.refrescos || []), ...carta.menu, ...carta.extras, ...(carta.bebidas || [])];
  const lista = todos.filter((p) => f === 'todas' || p.tipo === f);
  const delDia = carta.guarniciones.filter((g) => g.activo && g.del_dia);
  const aEleccion = delDia.map((g) => g.nombre);
  const menuHoy = carta.sopa ? carta.menu.filter((p) => p.activo && p.en_carta).length : 0;
  const extrasActivos = carta.extras.filter((p) => p.activo).length;
  const bebidasActivos = (carta.bebidas || []).filter((p) => p.activo).length;
  // Estado: sopa / segundo variable = "sale hoy"; segundo fijo, extras y bebidas = activo
  const delDiaMenu = (p) => p.tipo === 'menu' && p.menu_rol !== 'fijo';
  const encendido = (p) => (delDiaMenu(p) ? p.en_carta && p.activo : p.activo);
  const interruptor = (p) =>
    admin
      ? `<button class="interruptor ${encendido(p) ? 'on' : ''}" data-estado-plato="${p.id}" role="switch" aria-checked="${encendido(p) ? 'true' : 'false'}"
           aria-label="${delDiaMenu(p) ? 'Sale hoy' : 'Activo'}: ${esc(p.nombre)}"></button>`
      : '';
  const guarnicion = (p) =>
    p.tipo === 'bebidas' || p.menu_rol === 'sopa' || p.menu_rol === 'refresco'
      ? '<span class="suave">—</span>'
      : p.guarnicion_base || p.con_eleccion
        ? `${p.guarnicion_base ? esc(p.guarnicion_base) : '—'}<div class="suave peq">${p.con_eleccion ? '+ 1 a elección (sin costo)' : 'cambiable'}</div>`
        : '<span class="suave">Sin guarnición</span>';
  const fila = (p) => `
    <tr data-buscar="${esc((p.nombre + ' ' + p.categoria + ' ' + p.descripcion).toLowerCase())}" class="${encendido(p) ? '' : 'apagado'}">
      <td><b>${esc(p.nombre)}</b>${p.descripcion ? `<div class="suave peq recorte">${esc(p.descripcion)}</div>` : ''}</td>
      <td>${p.tipo === 'menu' ? `Menú · ${ROL_MENU[p.menu_rol]}` : p.tipo === 'bebidas' ? 'Bebidas' : 'Extras'}<div class="suave peq">${esc(p.categoria)}</div></td>
      <td>${guarnicion(p)}</td>
      <td class="num precio">${p.tipo === 'menu' ? '<span class="suave">—</span>' : p.precio > 0 ? dinero(p.precio) : '<span class="suave">Sin precio</span>'}</td>
      ${admin ? `<td>${interruptor(p)}</td>` : ''}
      <td>${
        puedeAgotar
          ? `<button class="insignia ${p.disponible ? 'si' : 'no'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}" title="Tocar para cambiar">${p.disponible ? 'Disponible' : 'Agotado'}</button>`
          : `<span class="insignia ${p.disponible ? 'si' : 'no'}">${p.disponible ? 'Disponible' : 'Agotado'}</span>`
      }</td>
      ${admin ? `<td><button class="btn chico" data-editar-plato="${p.id}" aria-label="Editar ${esc(p.nombre)}">${svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 16)}</button></td>` : ''}
    </tr>`;
  const tarjetaCarta = (v, titulo, sub) =>
    `<button class="tarjeta carta-resumen ${f === v ? 'activo' : ''}" data-chip="fc" data-v="${v}"><b>${titulo}</b><small class="suave">${sub}</small></button>`;
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre envolver">
        <div><h2 style="margin:0">Gestión de Cartas</h2><div class="suave">${todos.length} platos configurados</div></div>
        ${
          admin
            ? `<div class="fila envolver"><button class="btn chico" id="planificar">📅 Planificar otro día</button>
               <button class="btn chico" id="guarniciones">🥗 Guarniciones</button>
               <button class="btn chico primario" id="nuevo">＋ Nuevo plato</button></div>`
            : ''
        }
      </div>
      <div class="fila envolver">
        ${tarjetaCarta('menu', 'Menú del día', carta.sopa ? `${dinero(carta.precio_menu)} · ${esc(carta.sopa.nombre)}${carta.refresco ? ` + ${esc(carta.refresco.nombre)}` : ''} + ${menuHoy} segundos` : 'Hoy sin menú (falta la sopa)')}
        ${tarjetaCarta('extra', 'Extras', `${extrasActivos} platos activos · carta fija`)}
        ${tarjetaCarta('bebidas', 'Bebidas', `${bebidasActivos} bebidas activas · carta fija`)}
        <div class="tarjeta carta-resumen"><b>A elección hoy</b><small class="suave">${esc(aEleccion.join(', ') || 'ninguna marcada')}</small></div>
      </div>
      <div class="fila entre envolver">
        <div class="segmento compacto">${[['todas', 'Todas'], ['menu', 'Menú del día'], ['extra', 'Extras'], ['bebidas', 'Bebidas']]
          .map(([v, t]) => `<button class="${f === v ? 'activo' : ''}" data-chip="fc" data-v="${v}">${t}</button>`)
          .join('')}</div>
        <input class="entrada" id="buscar" type="search" placeholder="🔎 Buscar plato…" autocomplete="off" style="max-width:280px">
      </div>
      <div class="tarjeta tabla-wrap" style="padding:0">
        <table class="tabla-carta">
          <thead><tr><th>Plato</th><th>Carta / Categoría</th><th>Guarnición</th><th class="num">Precio</th>
            ${admin ? '<th>Estado</th>' : ''}<th>Agotado</th>${admin ? '<th>Acciones</th>' : ''}</tr></thead>
          <tbody>${lista.map(fila).join('') || `<tr><td colspan="7" class="vacio">Sin platos.</td></tr>`}</tbody>
        </table>
      </div>
      <p class="suave peq">El menú (sopa + refresco + segundo) se cobra a precio fijo. Los segundos y extras llevan su guarnición por defecto; el cliente puede cambiarla y/o agregar una a elección del día sin costo adicional.</p>
    </div>`;
  enlazarChips(main, 'fc', (v) => {
    S.filtroCarta = S.filtroCarta === v ? 'todas' : v;
    vCarta(main);
  });
  $('#buscar', main).oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('tbody tr[data-buscar]', main).forEach((x) => x.classList.toggle('oculto', q && !x.dataset.buscar.includes(q)));
  };
  if (!admin) return;
  const buscar = (id) => todos.find((p) => p.id === Number(id));
  $('#nuevo', main).onclick = () => formularioPlato(null, { tipo: f === 'extra' ? 'extra' : f === 'bebidas' ? 'bebidas' : 'variable' });
  $('#planificar', main).onclick = () => ((S.adminTab = 'carta'), ir('#/admin'));
  $('#guarniciones', main).onclick = () => ((S.adminTab = 'guarniciones'), ir('#/admin'));
  $$('[data-editar-plato]', main).forEach((x) => (x.onclick = () => formularioPlato(buscar(x.dataset.editarPlato))));
  $$('[data-estado-plato]', main).forEach(
    (x) =>
      (x.onclick = async () => {
        const p = buscar(x.dataset.estadoPlato);
        try {
          if (delDiaMenu(p)) {
            // un plato de menú inactivo se reactiva al sacarlo hoy
            if (!p.activo) await api('PUT', `/api/productos/${p.id}`, { ...p, activo: true });
            await api('POST', '/api/carta/menu', { producto_id: p.id, incluir: !encendido(p) });
          } else await api('PUT', `/api/productos/${p.id}`, { ...p, activo: !p.activo });
          recargarVista();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );
}

// ---------- Reporte del día ----------
async function vReporte(main) {
  const fecha = S.fechaReporte || fechaHoy();
  const r = await api('GET', `/api/reportes/dia?fecha=${fecha}`);
  const x = r.resumen;
  const kpi = (v, l) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  const tabla = (cabeceras, filas) =>
    filas.length
      ? `<div class="tabla-wrap"><table><thead><tr>${cabeceras.map((h) => `<th class="${h.startsWith('#') ? 'num' : ''}">${h.replace('#', '')}</th>`).join('')}</tr></thead>
         <tbody>${filas.map((f) => `<tr>${f.map((v, i) => `<td class="${cabeceras[i].startsWith('#') ? 'num' : ''}">${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<div class="suave">Sin datos.</div>';
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre envolver"><h2>Reporte del día</h2>
        <div class="fila no-imprimir"><input type="date" class="entrada" id="fecha" value="${fecha}" max="${fechaHoy()}" style="width:auto">
        <button class="btn chico" onclick="print()">🖨️</button></div></div>
      <div class="suave peq">Fecha: <b>${r.fecha}</b> · Generado ${new Date().toLocaleTimeString()}</div>
      <div class="kpis">
        ${kpi(x.comandas, 'Comandas')}
        ${kpi(x.mesas_atendidas, 'Mesas atendidas')}
        ${kpi(x.empleados_en_turno, 'Empleados en turno')}
        ${kpi(dinero(x.total_vendido), 'Total vendido')}
        ${kpi(x.en_mesa || 0, 'En mesa')}
        ${kpi(x.para_llevar || 0, 'Para llevar')}
        ${kpi(dinero(x.total_cobrado), 'Cobrado')}
        ${kpi(x.tiempo_promedio_entrega != null ? `${Math.round(x.tiempo_promedio_entrega)} min` : '-', 'Prom. cocina → entrega')}
      </div>
      <div class="tarjeta"><h3>Cobros por forma de pago</h3>
        ${tabla(['Forma de pago', '#Cobros', '#Total'], r.pagos.map((p) => [esc(p.metodo), p.cobros, dinero(p.total)]))}
      </div>
      <div class="tarjeta"><h3>Comandas por estado</h3>
        ${tabla(['Estado', '#Cantidad'], r.porEstado.map((e) => [badge(e.estado), e.cantidad]))}
        <div class="suave peq" style="margin-top:6px">Canceladas: ${x.canceladas} (no suman en totales) · Ticket promedio: ${dinero(x.ticket_promedio)}</div>
      </div>
      <div class="tarjeta"><h3>Empleados en turno</h3>
        ${tabla(['Nombre', 'Rol', 'Inicio', 'Fin'], r.empleados.map((e) => [esc(e.nombre), ROL_TXT[e.rol], hora(e.inicio), e.fin ? hora(e.fin) : '🟢 en turno']))}
      </div>
      <div class="tarjeta"><h3>Por empleado (quien tomó la comanda)</h3>
        ${tabla(['Empleado', '#Comandas', '#Mesas', '#Total'], r.porMozo.map((m) => [esc(m.mozo), m.comandas, m.mesas, dinero(m.total)]))}
      </div>
      <div class="tarjeta"><h3>Mesas atendidas</h3>
        ${tabla(['Mesa', '#Comandas', '#Total'], r.mesas.map((m) => [esc(m.mesa), m.comandas, dinero(m.total)]))}
      </div>
      <div class="tarjeta"><h3>Platos más vendidos</h3>
        ${tabla(['Plato', 'Tipo', '#Cant.', '#Total'], r.productos.map((p) => [esc(p.nombre), p.tipo === 'menu' ? 'Menú' : p.tipo === 'bebidas' ? 'Bebida' : 'Extra', p.cantidad, dinero(p.total)]))}
      </div>
      <div class="tarjeta"><h3>Guarniciones servidas</h3>
        ${tabla(['Guarnición', '#Porciones'], r.guarniciones.map((g) => [esc(g.nombre), g.cantidad]))}
      </div>
    </div>`;
  $('#fecha', main).onchange = (e) => {
    S.fechaReporte = e.target.value || null;
    vReporte(main);
  };
}

// ---------- Gestión (admin) ----------
async function vAdmin(main) {
  const tabs = [['carta', '📅 Carta del día'], ['platos', '🍲 Platos'], ['guarniciones', '🥗 Guarniciones'], ['mesas', '🍽️ Mesas'], ['usuarios', '👤 Usuarios'], ['impresora', '🖨️ Impresora'], ['config', '⚙️ Configuración']];
  main.innerHTML = `<div class="pila">${chips(tabs, S.adminTab, 'at')}<div id="admin-cont"></div></div>`;
  enlazarChips(main, 'at', (v) => {
    S.adminTab = v;
    vAdmin(main);
  });
  const cont = $('#admin-cont', main);
  await { carta: adminCarta, platos: adminPlatos, guarniciones: adminGuarniciones, mesas: adminMesas, usuarios: adminUsuarios, impresora: adminImpresora, config: adminConfiguracion }[S.adminTab](cont);
}

/** Gestión → Impresora: conexión de la ticketera térmica y qué imprime */
async function adminImpresora(cont) {
  const { ajustes: a, estado, cola, windows } = await api('GET', '/api/impresora');
  const opt = (lista, actual) => lista.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(actual) ? 'selected' : ''}>${esc(t)}</option>`).join('');
  const modos = [
    ['ninguna', 'Sin ticketera (PDF desde el navegador)'],
    ['com', 'Bluetooth o USB (puerto COM)'],
    ['windows', 'Impresora instalada en Windows'],
    ['red', 'Impresora de red (IP)'],
    ['archivo', 'Archivo (solo pruebas, sin impresora)'],
  ];
  const ESTADO_COLA = { pendiente: 'En cola', error: 'Sin respuesta', impreso: 'Impreso', cancelado: 'Quitado' };
  cont.innerHTML = `
    <div class="pila">
      <form class="tarjeta pila" id="form-impresora" novalidate>
        <h3>🖨️ Ticketera térmica</h3>
        <p class="suave peq">El servidor imprime directo en la ticketera (comandas, precuentas y comprobantes), sin abrir el diálogo
          del navegador, y corta el papel. Si la impresora no responde, los tickets esperan en cola y se reintentan solos.</p>
        <label class="campo"><span>Conexión</span><select name="modo">${opt(modos, a.modo)}</select></label>
        ${!windows ? '<div class="aviso-suave">El servidor no está en Windows: las opciones "puerto COM" e "impresora instalada en Windows" solo funcionan con el servidor en Windows.</div>' : ''}

        <div class="pila" data-modo="com">
          <label class="campo"><span>Puerto COM</span><input name="puerto" list="lista-puertos" value="${esc(a.puerto)}" placeholder="COM5" autocomplete="off"></label>
          <small class="suave">Bluetooth: empareje la impresora en Windows (Configuración → Dispositivos → Bluetooth). En "Más opciones de
            Bluetooth → Puertos COM" use el puerto <b>saliente</b> de la impresora. También puede usar "Buscar dispositivos".</small>
          <label class="campo"><span>Velocidad (baudios)</span><select name="baudios">${opt([[9600, '9600 (normal)'], [19200, '19200'], [38400, '38400'], [115200, '115200']], a.baudios)}</select></label>
        </div>
        <div class="pila" data-modo="windows">
          <label class="campo"><span>Nombre de la impresora en Windows</span><input name="nombre" list="lista-impresoras" value="${esc(a.nombre)}" placeholder="XP-80C" autocomplete="off"></label>
          <small class="suave">Debe estar instalada con el controlador del fabricante (Panel de control → Dispositivos e impresoras).</small>
        </div>
        <div class="pila" data-modo="red">
          <label class="campo"><span>IP de la impresora</span><input name="host" value="${esc(a.host)}" placeholder="192.168.1.50" autocomplete="off"></label>
          <label class="campo"><span>Puerto</span><input name="puertoRed" type="number" value="${esc(a.puertoRed)}"></label>
        </div>
        <div data-modo="com windows">
          <button type="button" class="btn chico" id="buscar-disp">🔎 Buscar dispositivos</button>
          <div id="dispositivos" class="suave peq"></div>
        </div>
        <datalist id="lista-puertos"></datalist><datalist id="lista-impresoras"></datalist>

        <div class="pila" data-modo="com windows red archivo">
          <h3>Papel</h3>
          <label class="campo"><span>Ancho</span><select name="columnas">${opt([[48, '80 mm · 48 caracteres (habitual)'], [42, '80 mm · 42 caracteres'], [32, '58 mm · 32 caracteres']], a.columnas)}</select></label>
          <label class="campo"><span>Acentos y ñ (página de códigos)</span><select name="pagina">${opt([['cp850', 'PC850 (recomendado)'], ['wpc1252', 'Windows-1252']], a.pagina)}</select></label>
          <small class="suave">Si en el ticket de prueba los acentos salen como símbolos raros, cambie esta opción.</small>
          <label class="check"><input type="checkbox" name="cortar" ${a.cortar ? 'checked' : ''}> Cortar el papel al final de cada ticket</label>
          <label class="check"><input type="checkbox" name="logo" ${a.logo ? 'checked' : ''}> Imprimir el logo en precuentas y comprobantes</label>

          <h3>Qué imprime</h3>
          <label class="check"><input type="checkbox" name="autoComandas" ${a.autoComandas ? 'checked' : ''}> Imprimir cada comanda automáticamente al enviarla a cocina</label>
          <label class="campo"><span>Copias de cada comanda</span><select name="copiasComanda">${opt([[1, '1'], [2, '2'], [3, '3']], a.copiasComanda)}</select></label>
          <label class="check"><input type="checkbox" name="caja" ${a.caja ? 'checked' : ''}> Imprimir también precuentas y comprobantes de pago</label>
        </div>
        <div class="error" data-err></div>
        <div class="fila envolver">
          <button class="btn primario crecer">Guardar</button>
          <button type="button" class="btn" id="probar" ${estado.activa ? '' : 'disabled'}>Imprimir prueba</button>
        </div>
      </form>

      <div class="tarjeta">
        <div class="fila entre envolver"><h3>Últimos trabajos</h3>
          ${estado.errores ? '<button class="btn chico primario" id="reintentar-todo">Reintentar ahora</button>' : ''}</div>
        ${estado.errores ? `<div class="aviso-suave error-txt">⚠️ ${esc(estado.ultimoError)}</div>` : ''}
        ${
          cola.length
            ? `<ul class="cola-impresion">${cola
                .slice(0, 20)
                .map(
                  (x) => `<li class="${x.estado}"><span>${esc(x.titulo)}
                    <small class="suave">${hora(x.creado_en)} · ${ESTADO_COLA[x.estado] || x.estado}${x.error && x.estado === 'error' ? ` · ${esc(x.error)}` : ''}</small></span>
                    ${['pendiente', 'error'].includes(x.estado) ? `<button class="btn chico" data-quitar="${x.id}">Quitar</button>` : ''}</li>`
                )
                .join('')}</ul>`
            : '<div class="suave">Todavía no se imprimió nada.</div>'
        }
      </div>
    </div>`;

  const f = $('#form-impresora', cont);
  const mostrar = () =>
    $$('[data-modo]', f).forEach((el) => el.classList.toggle('oculto', !el.dataset.modo.split(' ').includes(f.modo.value)));
  f.modo.onchange = mostrar;
  mostrar();

  $('#buscar-disp', cont).onclick = async (e) => {
    const caja = $('#dispositivos', cont);
    e.target.disabled = true;
    caja.textContent = 'Buscando…';
    try {
      const d = await api('GET', '/api/impresora/dispositivos');
      $('#lista-puertos', cont).innerHTML = d.puertos.map((p) => `<option value="${esc(p.puerto)}">${esc(p.nombre)}</option>`).join('');
      $('#lista-impresoras', cont).innerHTML = d.impresoras.map((n) => `<option value="${esc(n)}">`).join('');
      caja.innerHTML = d.aviso
        ? esc(d.aviso)
        : `<b>Puertos COM:</b> ${d.puertos.map((p) => `<button type="button" class="chip" data-usar-puerto="${esc(p.puerto)}">${esc(p.nombre)}</button>`).join(' ') || 'ninguno'}<br>
           <b>Impresoras de Windows:</b> ${d.impresoras.map((n) => `<button type="button" class="chip" data-usar-impresora="${esc(n)}">${esc(n)}</button>`).join(' ') || 'ninguna'}`;
      $$('[data-usar-puerto]', caja).forEach((b) => (b.onclick = () => ((f.puerto.value = b.dataset.usarPuerto), (f.modo.value = 'com'), mostrar())));
      $$('[data-usar-impresora]', caja).forEach((b) => (b.onclick = () => ((f.nombre.value = b.dataset.usarImpresora), (f.modo.value = 'windows'), mostrar())));
    } catch (err) {
      caja.textContent = err.message;
    }
    e.target.disabled = false;
  };

  f.onsubmit = async (e) => {
    e.preventDefault();
    const datos = {};
    for (const el of f.elements) if (el.name) datos[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    try {
      await api('PUT', '/api/impresora', datos);
      toast('Ajustes de la ticketera guardados', 'ok');
      await cargarTicketera();
      adminImpresora(cont);
    } catch (err) {
      $('[data-err]', f).textContent = err.message;
    }
  };
  $('#probar', cont).onclick = () => aTicketera('/api/impresora/prueba', {}, 'Ticket de prueba enviado');
  const rt = $('#reintentar-todo', cont);
  if (rt) rt.onclick = () => api('POST', '/api/impresora/reintentar', {}).catch((err) => toast(err.message, 'error'));
  $$('[data-quitar]', cont).forEach(
    (x) => (x.onclick = () => api('POST', '/api/impresora/cancelar', { id: Number(x.dataset.quitar) }).then(() => adminImpresora(cont)).catch((err) => toast(err.message, 'error')))
  );
}

/** Formulario de plato (crear o editar) */
const ROL_MENU = { sopa: 'Sopa', refresco: 'Refresco', fijo: 'Segundo fijo', variable: 'Segundo variable' };
async function formularioPlato(p, { tipo, fecha } = {}) {
  const [guarniciones, productos] = await Promise.all([api('GET', '/api/guarniciones'), api('GET', '/api/productos')]);
  const categorias = [...new Set(productos.map((x) => x.categoria).filter(Boolean))];
  const campos = [
    { n: 'nombre', l: 'Nombre del plato', req: true },
    {
      n: 'tipo',
      l: 'Tipo',
      t: 'select',
      op: [
        ['variable', 'Menú · segundo variable (se elige qué días sale)'],
        ['fijo', 'Menú · segundo fijo (sale todos los días con menú)'],
        ['sopa', 'Menú · sopa (una por día)'],
        ['refresco', 'Menú · refresco (uno por día)'],
        ['extra', 'Extra (carta fija, precio propio)'],
        ['bebidas', 'Bebida (carta fija, precio propio)'],
      ],
      def: tipo || 'variable',
    },
    { n: 'precio', l: `Precio (${S.config.moneda}) — solo extras y bebidas`, t: 'number', paso: '0.10', ayuda: 'Lo del menú (sopa, refresco, segundos) se cobra al precio fijo del menú.' },
    {
      n: 'guarnicion_base_id',
      l: 'Guarnición por defecto',
      t: 'select',
      op: [['', '— Sin guarnición —'], ...guarniciones.filter((g) => g.activo).map((g) => [g.id, g.nombre])],
      def: tipo === 'bebidas' ? '' : (guarniciones.find((g) => g.activo && g.nombre.toLowerCase() === 'arroz')?.id ?? ''),
      ayuda: 'El mozo la puede cambiar por otra al tomar el pedido.',
    },
    { n: 'con_eleccion', l: 'Lleva una guarnición a elección', t: 'check', def: tipo !== 'bebidas', ayuda: 'Ej: picante de lisas, kapchi… (las que se ofrecen ese día)' },
    { n: 'categoria', l: 'Categoría (para ordenar la carta)', lista: categorias, def: tipo === 'bebidas' ? 'Bebidas' : tipo === 'extra' ? 'Fondos' : 'Menú del día' },
    { n: 'descripcion', l: 'Descripción (opcional)' },
  ];
  const f = formulario({
    titulo: p ? `Editar: ${p.nombre}` : 'Nuevo plato',
    campos,
    valores: p ? { ...p, tipo: p.tipo === 'menu' ? p.menu_rol : p.tipo, guarnicion_base_id: p.guarnicion_base_id ?? '' } : {},
    enviar: (d) => {
      d = { ...d, tipo: ['extra', 'bebidas'].includes(d.tipo) ? d.tipo : 'menu', menu_rol: ['extra', 'bebidas'].includes(d.tipo) ? 'variable' : d.tipo };
      return p ? api('PUT', `/api/productos/${p.id}`, d) : api('POST', '/api/productos', { ...d, agregar_a_fecha: fecha || true });
    },
    eliminar: p
      ? async () => {
          await api('DELETE', `/api/productos/${p.id}`);
          cerrarModal();
          toast('Plato eliminado', 'ok');
        }
      : null,
  });
  // precio solo para extras y bebidas; sopa y bebidas no llevan guarnición
  const el = f.elements;
  const ajustar = () => {
    el.precio.closest('label').style.display = ['extra', 'bebidas'].includes(el.tipo.value) ? '' : 'none';
    const sinGuar = ['sopa', 'refresco', 'bebidas'].includes(el.tipo.value);
    if (sinGuar) (el.guarnicion_base_id.value = ''), (el.con_eleccion.checked = false);
    el.guarnicion_base_id.disabled = el.con_eleccion.disabled = sinGuar;
  };
  el.tipo.onchange = ajustar;
  ajustar();
}

/** Carta del día: qué platos y guarniciones salen */
async function adminCarta(cont) {
  const fecha = S.fechaCarta || fechaHoy();
  const carta = await api('GET', `/api/carta?fecha=${fecha}&completo=1`);
  const menu = carta.menu.filter((p) => p.activo);
  const fijos = menu.filter((p) => p.menu_rol === 'fijo');
  const variablesDelDia = menu.filter((p) => p.menu_rol !== 'fijo' && p.en_carta);
  const variablesDisponibles = menu.filter((p) => p.menu_rol !== 'fijo' && !p.en_carta);
  const sopas = carta.sopas.filter((p) => p.activo);
  const refrescos = carta.refrescos.filter((p) => p.activo);
  const delDia = carta.guarniciones.filter((g) => g.activo && g.del_dia);
  const esHoy = fecha === fechaHoy();

  const infoGuar = (p) => [p.guarnicion_base ? `con ${esc(p.guarnicion_base.toLowerCase())}` : '', p.con_eleccion ? '+ a elección' : '', esc(p.descripcion)].filter(Boolean).join(' ') || '&nbsp;';

  // Fila de segundo fijo: sin toggle, siempre activo
  const filaFijo = (p) => `
    <div class="toggle-fila on">
      <div class="crecer">
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${infoGuar(p)}</div>
      </div>
      <button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button>
      <button class="btn chico" data-editar-plato="${p.id}" aria-label="Editar">✏️</button>
    </div>`;

  // Fila de segundo variable en el día: botón para quitar
  const filaVariable = (p) => `
    <div class="toggle-fila on">
      <div class="crecer">
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${infoGuar(p)}</div>
      </div>
      <button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button>
      <button class="btn chico" data-menu="${p.id}" data-v="0" aria-label="Quitar del día">✕ Quitar</button>
    </div>`;

  const opcionesSopa = sopas
    .map((s) => `<option value="${s.id}" ${carta.sopa?.id === s.id ? 'selected' : ''}>${esc(s.nombre)}</option>`)
    .join('');

  cont.innerHTML = `
    <div class="pila">
      <div class="tarjeta fila entre envolver">
        <div class="fila"><input type="date" class="entrada" id="fecha" value="${fecha}" style="width:auto">
          <span class="suave">${esHoy ? 'Hoy' : ''}</span></div>
        <button class="btn chico" id="copiar">📋 Copiar carta del día anterior</button>
      </div>

      <div class="tarjeta pila">
        <h3>📅 Menú del día</h3>
        <p class="suave peq">El menú es sopa + refresco + un segundo a elección, siempre al mismo precio. El precio se configura en la pestaña Configuración.</p>

        <div class="fila entre"><h4>🍲 Sopa del día</h4><button class="btn chico" data-nuevo-menu="sopa">＋ Nueva sopa</button></div>
        <div class="fila entre envolver" style="gap:8px;align-items:center">
          <div>
            ${carta.sopa
              ? `<div class="nombre">${esc(carta.sopa.nombre)}</div>`
              : `<div class="suave">Sin sopa — el menú no estará disponible este día.</div>`}
          </div>
          ${sopas.length ? `<select class="entrada" id="sel-sopa" style="width:auto">
            <option value="">— ${carta.sopa ? 'Cambiar sopa' : 'Elegir sopa'} —</option>
            ${opcionesSopa}
          </select>` : ''}
        </div>

        <div class="fila entre"><h4>🥤 Refresco del día</h4><button class="btn chico" data-nuevo-menu="refresco">＋ Nuevo refresco</button></div>
        <div class="fila entre envolver" style="gap:8px;align-items:center">
          <div>
            ${carta.refresco
              ? `<div class="nombre">${esc(carta.refresco.nombre)}</div>`
              : `<div class="suave">Sin refresco este día (opcional).</div>`}
          </div>
          ${refrescos.length ? `<select class="entrada" id="sel-refresco" style="width:auto">
            <option value="">— ${carta.refresco ? 'Cambiar refresco' : 'Elegir refresco'} —</option>
            ${refrescos.map((r) => `<option value="${r.id}" ${carta.refresco?.id === r.id ? 'selected' : ''}>${esc(r.nombre)}</option>`).join('')}
          </select>` : ''}
        </div>

        <div class="fila entre"><h4>📌 Segundos fijos (salen siempre con el menú)</h4><button class="btn chico" data-nuevo-menu="fijo">＋ Nuevo fijo</button></div>
        ${fijos.map(filaFijo).join('') || '<div class="suave">Sin segundos fijos.</div>'}

        <div class="fila entre"><h4>🔄 Segundos del día</h4><button class="btn chico" data-nuevo-menu="variable">＋ Nuevo variable</button></div>
        ${variablesDelDia.map(filaVariable).join('') || '<div class="suave">Sin segundos seleccionados para hoy.</div>'}
        ${variablesDisponibles.length ? `<select class="entrada" id="add-variable" style="width:100%">
          <option value="">＋ Agregar segundo al día…</option>
          ${variablesDisponibles.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}
        </select>` : ''}
      </div>

      <div class="tarjeta">
        <div class="fila entre"><h3>🥗 Guarniciones a elección (${delDia.length})</h3></div>
        <p class="suave peq">Toque para marcar las que se ofrecen este día. Si no marca ninguna, ese día no hay guarnición a elección.</p>
        <div class="opciones">${carta.guarniciones
          .filter((g) => g.activo)
          .map((g) => `<button class="chip ${g.del_dia ? 'activo' : ''}" data-guar="${g.id}" data-v="${g.del_dia ? 0 : 1}">${g.del_dia ? '✓ ' : ''}${esc(g.nombre)}</button>`)
          .join('')}</div>
        <form class="fila" id="form-guar" style="margin-top:10px"><input class="entrada crecer" name="nombre" placeholder="Nueva guarnición…" autocomplete="off"><button class="btn chico">Agregar</button></form>
      </div>

      <div class="tarjeta">
        <div class="fila entre"><h3>⭐ Extras (salen todos los días)</h3><button class="btn chico" id="ver-platos">Editar extras</button></div>
        ${carta.extras
          .filter((p) => p.activo)
          .map(
            (p) => `<div class="toggle-fila"><div class="crecer"><div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
              <div class="suave peq">${dinero(p.precio)} · ${esc(p.categoria)}</div></div>
              <button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button></div>`
          )
          .join('')}
      </div>

      <div class="tarjeta">
        <div class="fila entre"><h3>🍹 Bebidas (salen todos los días)</h3><button class="btn chico" id="ver-bebidas">Editar bebidas</button></div>
        ${(carta.bebidas || [])
          .filter((p) => p.activo)
          .map(
            (p) => `<div class="toggle-fila"><div class="crecer"><div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
              <div class="suave peq">${dinero(p.precio)} · ${esc(p.categoria)}</div></div>
              <button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button></div>`
          )
          .join('') || '<div class="suave">Sin bebidas. Agregue desde "Editar bebidas".</div>'}
      </div>
    </div>`;

  const recargar = () => adminCarta(cont);

  $('#fecha', cont).onchange = (e) => {
    S.fechaCarta = e.target.value || null;
    recargar();
  };

  $('#copiar', cont).onclick = async () => {
    const desde = diaAnterior(fecha);
    try {
      const r = await api('POST', '/api/carta/copiar', { desde, hasta: fecha });
      toast(r.copiados ? `Carta del ${desde} copiada` : 'Ya estaba igual', 'ok');
      recargar();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const alternarMenu = async (id, v) => {
    try {
      await api('POST', '/api/carta/menu', { fecha, producto_id: id, incluir: v });
      recargar();
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  // Selectores de sopa / refresco: cambiar al seleccionar
  for (const sel of [$('#sel-sopa', cont), $('#sel-refresco', cont)]) {
    if (!sel) continue;
    sel.onchange = async () => {
      const id = Number(sel.value);
      if (!id) return;
      await alternarMenu(id, true);
    };
  }

  // Selector para agregar segundo variable al día
  const addVar = $('#add-variable', cont);
  if (addVar) {
    addVar.onchange = async () => {
      const id = Number(addVar.value);
      if (!id) return;
      await alternarMenu(id, true);
    };
  }

  // Botón quitar segundo variable
  $$('[data-menu]', cont).forEach((x) => (x.onclick = () => alternarMenu(Number(x.dataset.menu), x.dataset.v === '1')));

  $$('[data-guar]', cont).forEach(
    (x) =>
      (x.onclick = async () => {
        try {
          await api('POST', '/api/carta/guarnicion', { fecha, guarnicion_id: Number(x.dataset.guar), incluir: x.dataset.v === '1' });
          recargar();
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );

  $('#form-guar', cont).onsubmit = async (e) => {
    e.preventDefault();
    const nombre = e.target.nombre.value.trim();
    if (!nombre) return;
    try {
      const g = await api('POST', '/api/guarniciones', { nombre });
      await api('POST', '/api/carta/guarnicion', { fecha, guarnicion_id: g.id, incluir: true });
      recargar();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  $$('[data-nuevo-menu]', cont).forEach((x) => (x.onclick = () => formularioPlato(null, { tipo: x.dataset.nuevoMenu, fecha })));
  $$('[data-editar-plato]', cont).forEach((x) => (x.onclick = () => formularioPlato([...menu, ...sopas, ...refrescos].find((p) => p.id === Number(x.dataset.editarPlato)))));

  $('#ver-platos', cont).onclick = () => {
    S.adminTab = 'platos';
    S.filtroPlatos = 'extra';
    vAdmin($('#vista'));
  };
  $('#ver-bebidas', cont).onclick = () => {
    S.adminTab = 'platos';
    S.filtroPlatos = 'bebidas';
    vAdmin($('#vista'));
  };
}

/** Configuración general del restaurante */
async function adminConfiguracion(cont) {
  const ajustes = await api('GET', '/api/ajustes');
  cont.innerHTML = `
    <div class="pila">
      <div class="tarjeta pila">
        <h3>⚙️ Configuración</h3>
        <form class="pila" id="form-config" novalidate>
          <label class="campo">
            <span>Precio del menú del día</span>
            <input class="entrada" name="precio_menu" type="number" step="0.10" min="0" inputmode="decimal"
              value="${ajustes.precio_menu || ''}" placeholder="0.00" required>
          </label>
          <button class="btn primario" type="submit">Guardar</button>
        </form>
      </div>
    </div>`;
  $('#form-config', cont).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/carta/precio-menu', { precio: Number(e.target.precio_menu.value) });
      toast('Configuración guardada', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
}

/** Catálogo de platos */
async function adminPlatos(cont) {
  const productos = await api('GET', '/api/productos');
  const f = S.filtroPlatos;
  const lista = productos.filter((p) => f === 'todos' || p.tipo === f);
  cont.innerHTML = `
    <div class="tarjeta pila">
      <div class="fila entre envolver"><h3>Platos (${lista.length})</h3><button class="btn chico primario" id="nuevo">＋ Nuevo plato</button></div>
      ${chips([['todos', 'Todos'], ['menu', 'Menú del día'], ['extra', 'Extras'], ['bebidas', 'Bebidas']], f, 'fp')}
      <input class="entrada" id="buscar" placeholder="🔎 Buscar…" autocomplete="off">
      <div class="lista-admin">${
        lista
          .map(
            (p) => `<div class="item" data-buscar="${esc(p.nombre.toLowerCase())}">
              <div class="crecer"><b>${esc(p.nombre)}</b> <span class="etiqueta">${p.tipo === 'menu' ? `MENÚ · ${ROL_MENU[p.menu_rol].toUpperCase()}` : p.tipo === 'bebidas' ? 'BEBIDA' : 'EXTRA'}</span>
                ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''} ${!p.activo ? '<span class="etiqueta">INACTIVO</span>' : ''}
                <div class="suave peq">${p.tipo === 'menu' ? 'precio del menú' : dinero(p.precio)} · ${esc(p.categoria)}${p.guarnicion_base ? ` · con ${esc(p.guarnicion_base.toLowerCase())}` : ''}${p.con_eleccion ? ' + a elección' : ''}</div></div>
              <button class="btn chico" data-edit="${p.id}">✏️</button></div>`
          )
          .join('') || '<div class="vacio">Sin platos.</div>'
      }</div>
    </div>`;
  enlazarChips(cont, 'fp', (v) => {
    S.filtroPlatos = v;
    adminPlatos(cont);
  });
  $('#buscar', cont).oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    $$('.item', cont).forEach((x) => x.classList.toggle('oculto', q && !x.dataset.buscar.includes(q)));
  };
  $('#nuevo', cont).onclick = () => formularioPlato(null, { tipo: f === 'extra' ? 'extra' : f === 'bebidas' ? 'bebidas' : 'variable' });
  $$('[data-edit]', cont).forEach((x) => (x.onclick = () => formularioPlato(productos.find((p) => p.id === Number(x.dataset.edit)))));
}

async function adminGuarniciones(cont) {
  const gs = await api('GET', '/api/guarniciones');
  cont.innerHTML = `
    <div class="tarjeta pila">
      <h3>Guarniciones (${gs.length})</h3>
      <p class="suave peq">Sirven como guarnición por defecto de un plato (ej: arroz) o como guarnición a elección del día (ej: kapchi).
        Las del día se marcan en "Carta del día".</p>
      <form class="fila" id="form-guar"><input class="entrada crecer" name="nombre" placeholder="Nueva guarnición…" autocomplete="off"><button class="btn primario">Agregar</button></form>
      <div class="lista-admin">${gs
        .map(
          (g) => `<div class="item"><div class="crecer"><b>${esc(g.nombre)}</b> ${!g.activo ? '<span class="etiqueta">INACTIVA</span>' : ''}</div>
            <button class="btn chico" data-edit="${g.id}">✏️</button></div>`
        )
        .join('')}</div>
    </div>`;
  $('#form-guar', cont).onsubmit = async (e) => {
    e.preventDefault();
    const nombre = e.target.nombre.value.trim();
    if (!nombre) return;
    try {
      await api('POST', '/api/guarniciones', { nombre });
      adminGuarniciones(cont);
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $$('[data-edit]', cont).forEach(
    (x) =>
      (x.onclick = () => {
        const g = gs.find((y) => y.id === Number(x.dataset.edit));
        formulario({
          titulo: 'Editar guarnición',
          campos: [
            { n: 'nombre', l: 'Nombre', req: true },
            { n: 'activo', l: 'Activa', t: 'check', def: true },
          ],
          valores: g,
          enviar: (d) => api('PUT', `/api/guarniciones/${g.id}`, d),
          eliminar: async () => {
            await api('DELETE', `/api/guarniciones/${g.id}`);
            cerrarModal();
            toast('Guarnición eliminada', 'ok');
          },
        });
      })
  );
}

async function adminUsuarios(cont) {
  const us = await api('GET', '/api/usuarios');
  const campos = (nuevo) => [
    { n: 'nombre', l: 'Nombre completo', req: true },
    { n: 'usuario', l: 'Usuario (identificador interno)', req: true },
    { n: 'pin', l: nuevo ? 'PIN (4 dígitos)' : 'Nuevo PIN (vacío = no cambiar)', t: 'password', attrs: 'inputmode="numeric" maxlength="4" pattern="\\d{4}"', req: nuevo },
    { n: 'rol', l: 'Rol principal', t: 'select', op: Object.entries(ROL_TXT), def: 'mozo' },
    { n: 'roles_extra', l: 'Roles adicionales', t: 'checks', op: Object.entries(ROL_TXT) },
    { n: 'activo', l: 'Activo (puede ingresar)', t: 'check', def: true },
  ];
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="fila entre"><h3>Usuarios (${us.length})</h3><button class="btn chico primario" id="nuevo">＋ Nuevo</button></div>
      <div class="lista-admin">${us
        .map(
          (u) => `<div class="item">
            <div class="crecer"><b>${esc(u.nombre)}</b> ${u.en_turno ? '<span class="etiqueta pagada">EN TURNO</span>' : ''} ${!u.activo ? '<span class="etiqueta agotado">INACTIVO</span>' : ''}
              <div class="suave peq">${esc(u.usuario)} · ${(u.roles || [u.rol]).map((r) => ROL_TXT[r]).join(' + ')}${(u.roles || [u.rol]).includes('mozo') ? ` · ${u.mesas_asignadas} mesa(s)` : ''}</div></div>
            <button class="btn chico" data-edit="${u.id}">Editar</button></div>`
        )
        .join('')}</div>
    </div>`;
  $('#nuevo', cont).onclick = () => formulario({ titulo: 'Nuevo usuario', campos: campos(true), enviar: (d) => api('POST', '/api/usuarios', d) });
  $$('[data-edit]', cont).forEach(
    (b) =>
      (b.onclick = () => {
        const u = us.find((x) => x.id === Number(b.dataset.edit));
        formulario({
          titulo: `Editar: ${u.nombre}`,
          campos: campos(false),
          valores: { ...u, pin: '', roles_extra: (u.roles || []).filter((r) => r !== u.rol) },
          enviar: (d) => api('PUT', `/api/usuarios/${u.id}`, d),
          eliminar:
            u.id !== S.me.id
              ? async () => {
                  const r = await api('DELETE', `/api/usuarios/${u.id}`);
                  cerrarModal();
                  toast(r.desactivado ? 'El usuario tiene historial: se desactivó' : 'Usuario eliminado', 'ok');
                }
              : null,
        });
      })
  );
}

async function adminMesas(cont) {
  const mesas = await api('GET', '/api/mesas');
  const campos = [
    { n: 'numero', l: 'Número o nombre de mesa', req: true },
    { n: 'capacidad', l: 'Capacidad (personas)', t: 'number', paso: '1', def: 4 },
    { n: 'piso', l: 'Nivel', def: 'Nivel 1', lista: [...new Set(mesas.map((m) => m.piso))], ayuda: 'La ubicación en el plano se ajusta en Salón → Editar plano' },
    { n: 'activa', l: 'Activa', t: 'check', def: true },
  ];
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="fila entre"><h3>Mesas (${mesas.length})</h3><button class="btn chico primario" id="nuevo">＋ Nueva</button></div>
      <div class="lista-admin">${mesas
        .map(
          (m) => `<div class="item">
            <div class="crecer"><b>Mesa ${esc(m.numero)}</b> ${m.ocupada ? '<span class="etiqueta llevar">OCUPADA</span>' : ''} ${!m.activa ? '<span class="etiqueta agotado">INACTIVA</span>' : ''}
              <div class="suave peq">${m.capacidad} personas · ${esc(m.piso)}</div></div>
            <button class="btn chico" data-edit="${m.id}">✏️</button></div>`
        )
        .join('')}</div>
    </div>`;
  $('#nuevo', cont).onclick = () => formulario({ titulo: 'Nueva mesa', campos, enviar: (d) => api('POST', '/api/mesas', d) });
  $$('[data-edit]', cont).forEach(
    (b) =>
      (b.onclick = () => {
        const m = mesas.find((x) => x.id === Number(b.dataset.edit));
        formulario({
          titulo: `Mesa ${m.numero}`,
          campos,
          valores: m,
          enviar: (d) => api('PUT', `/api/mesas/${m.id}`, d),
          eliminar: async () => {
            const r = await api('DELETE', `/api/mesas/${m.id}`);
            cerrarModal();
            toast(r.desactivada ? 'La mesa tiene historial: se desactivó' : 'Mesa eliminada', 'ok');
          },
        });
      })
  );
}

// ---------------- arranque ----------------
(async function arrancar() {
  try {
    const cfg = await api('GET', '/api/config');
    S.config = cfg;
    S.desfase = parseFecha(cfg.ahora).getTime() - Date.now();
    document.title = `Comandas · ${cfg.nombreRestaurante}`;
  } catch {}
  try {
    S.me = await fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null));
  } catch {
    S.me = null;
  }
  if (S.me) iniciarApp();
  else renderLogin();
})();
