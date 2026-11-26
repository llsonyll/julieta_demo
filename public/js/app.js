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
  const rol = S.me.rol;
  const enTickets = S.vista?.nombre === 'tickets';
  if (rol === 'cocina' || rol === 'caja' || (rol === 'admin' && enTickets)) {
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
    </div>`;

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

function abrirCobro(comandas, titulo) {
  const total = comandas.reduce((s, c) => s + c.total, 0);
  const metodos = S.config.metodosPago || ['Efectivo'];
  let metodo = metodos[0];
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
      <div><div class="etiqueta-campo">Forma de pago</div>
        <div class="opciones">${metodos.map((x) => `<button type="button" class="chip ${x === metodo ? 'activo' : ''}" data-metodo="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>
      <label class="campo" id="campo-recibido"><span>Recibido (opcional, para calcular el vuelto)</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" id="recibido" placeholder="${Number(total).toFixed(2)}"></label>
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
  recibido.oninput = () => {
    const r = Number(recibido.value);
    $('#vuelto', m).textContent = recibido.value && r >= total ? `Vuelto: ${dinero(r - total)}` : '';
  };
  $$('[data-metodo]', m).forEach(
    (b) =>
      (b.onclick = () => {
        metodo = b.dataset.metodo;
        $$('[data-metodo]', m).forEach((x) => x.classList.toggle('activo', x === b));
        $('#campo-recibido', m).classList.toggle('oculto', metodo !== 'Efectivo');
        $('#vuelto', m).classList.toggle('oculto', metodo !== 'Efectivo');
      })
  );

  $('#cobrar', m).onclick = async (e) => {
    const sunat = tipoComprobante === 'sunat';
    if (sunat && xml?.vista.coincide === false && !(await confirmarEnCobro())) return;
    e.target.disabled = true;
    const imprime = !sunat || xml; // sin XML no se imprime nada todavía
    const ventana = imprime && !usaTicketeraCaja() ? prepararVentana() : null;
    try {
      const cobro = await api('POST', '/api/cobros', {
        comanda_ids: comandas.map((c) => c.id),
        comprobante: tipoComprobante,
        metodo,
        recibido: metodo === 'Efectivo' && recibido.value !== '' ? Number(recibido.value) : null,
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
        <div class="suave peq">Dirección del sistema: <b>${esc(location.origin)}</b></div>
      </div>`);
    $('[data-x]', m).onclick = cerrarModal;
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
  'nueva-comanda': (el) => ir(`#/nueva${el.dataset.mesa ? `?mesa=${el.dataset.mesa}` : ''}`),
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
      abrirCobro([c], `Cobrar comanda #${c.numero_dia}`);
    } catch (e) {
      toast(e.message, 'error');
    }
  },
  comprobante: (el) =>
    usaTicketeraCaja()
      ? aTicketera('/api/imprimir/comprobante', { cobro_id: Number(el.dataset.cobro) }, 'Comprobante enviado a la ticketera')
      : imprimirPDF(`/api/cobros/${el.dataset.cobro}/comprobante.pdf`),
  'imprimir-sunat': (el) => imprimirSunat(Number(el.dataset.id)),
  'ir-comprobantes': () => ir('#/comprobantes'),
  'comprobante-pdf': (el) => imprimirPDF(`/api/cobros/${el.dataset.cobro}/comprobante.pdf`),
  'anular-cobro': async (el) => {
    if (!(await confirmar('¿Anular este cobro? Las comandas quedarán como no pagadas.', { ok: 'Anular cobro', peligro: true }))) return;
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
  const rol = S.me.rol;
  const btn = (estado, texto, clase = '') =>
    `<button class="btn chico ${clase}" data-accion="estado" data-id="${c.id}" data-estado="${estado}">${texto}</button>`;
  if (c.estado === 'generado' && ['admin', 'mozo', 'caja'].includes(rol)) {
    b.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar</button>`);
    b.push(btn('enviado_cocina', '🍳 Enviar a cocina', 'primario'));
  }
  if (EN_COCINA.includes(c.estado) && ['admin', 'mozo', 'caja'].includes(rol)) b.push(btn('entregado', '🍽️ Entregado', 'ok'));
  if (['admin', 'caja'].includes(rol) && !c.pagada && c.estado !== 'cancelado')
    b.push(`<button class="btn chico acento" data-accion="cobrar" data-id="${c.id}">💵 Cobrar</button>`);
  return b.join('');
}

function tarjetaComanda(c) {
  const pendienteTicket = EN_COCINA.includes(c.estado) && !c.ticket_impreso;
  return `
    <div class="tarjeta comanda ${claseEstado(c.estado)}" data-accion="ver-comanda" data-id="${c.id}">
      <div class="fila entre"><span class="num">#${c.numero_dia}</span>${badge(c.estado)}</div>
      <div class="fila envolver" style="margin-top:4px">${lugar(c)}
        <span class="suave peq">· ${esc(c.mozo_nombre || '')} · ${hora(c.creado_en)}</span>
        ${c.pagada ? `<span class="etiqueta pagada">PAGADA${c.metodo_pago ? ` · ${esc(c.metodo_pago.toUpperCase())}` : ''}</span>` : ''}
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
  const rol = S.me.rol;
  const filtros =
    rol === 'mozo'
      ? [['activas', 'Activas'], ['mias', 'Mías'], ['todas', 'Todas de hoy']]
      : [['activas', 'Activas'], ['por_cobrar', 'Por cobrar'], ['todas', 'Todas de hoy']];
  if (!filtros.some(([v]) => v === S.filtroComandas)) S.filtroComandas = 'activas';
  const f = S.filtroComandas;
  const qs = f === 'mias' ? 'vista=activas&mias=1' : f === 'todas' ? '' : `vista=${f}`;
  const lista = await api('GET', `/api/comandas${qs ? `?${qs}` : ''}`);
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>Comandas</h2>
        <span class="suave peq">${lista.length} ${lista.length === 1 ? 'comanda' : 'comandas'}</span></div>
      ${chips(filtros, f, 'filtro')}
      ${lista.length ? `<div class="grid">${lista.map(tarjetaComanda).join('')}</div>` : '<div class="vacio">No hay comandas en esta vista.</div>'}
    </div>
    <button class="btn primario fab" data-accion="nueva-comanda">＋ Nueva comanda</button>`;
  enlazarChips(main, 'filtro', (v) => {
    S.filtroComandas = v;
    vComandas(main);
  });
}

// ---------- Detalle ----------
async function vComandaDetalle(main, r) {
  const c = await api('GET', `/api/comandas/${r.param}`);
  const rol = S.me.rol;
  const acciones = [];
  if (rol !== 'cocina') acciones.push(botonesComanda(c));
  if (EN_COCINA.includes(c.estado) || c.estado === 'entregado')
    if (['admin', 'caja', 'cocina'].includes(rol))
      acciones.push(`<button class="btn chico" data-accion="imprimir-ticket" data-ids="${c.id}">🖨️ ${c.ticket_impreso ? 'Reimprimir' : 'Imprimir'} ticket</button>`);
  if (c.pagada && c.cobro_comprobante === 'sunat' && ['admin', 'caja'].includes(rol))
    acciones.push(
      c.sunat_id
        ? `<button class="btn chico primario" data-accion="imprimir-sunat" data-id="${c.sunat_id}">🏛️ ${esc(c.sunat_numero)}</button>`
        : `<button class="btn chico acento" data-accion="ir-comprobantes">🏛️ Falta subir el XML de SUNAT</button>`
    );
  if (c.pagada && c.cobro_id && ['admin', 'caja'].includes(rol)) {
    acciones.push(`<button class="btn chico" data-accion="comprobante" data-cobro="${c.cobro_id}">🧾 Nota de venta</button>`);
    if (usaTicketeraCaja()) acciones.push(`<button class="btn chico" data-accion="comprobante-pdf" data-cobro="${c.cobro_id}">PDF</button>`);
    acciones.push(`<button class="btn chico" data-accion="anular-cobro" data-cobro="${c.cobro_id}">Anular cobro</button>`);
  }
  const puedeCancelar =
    !c.pagada &&
    ((c.estado === 'generado' && ['mozo', 'caja', 'admin'].includes(rol)) ||
      (EN_COCINA.includes(c.estado) && ['caja', 'admin'].includes(rol)));
  if (puedeCancelar)
    acciones.push(`<button class="btn chico peligro" data-accion="estado" data-id="${c.id}" data-estado="cancelado">Cancelar comanda</button>`);
  if (rol === 'admin' && EN_COCINA.includes(c.estado) && !c.pagada)
    acciones.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar (admin)</button>`);
  if (rol === 'admin') acciones.push(`<button class="btn chico peligro" data-accion="eliminar-comanda" data-id="${c.id}">🗑 Eliminar</button>`);

  main.innerHTML = `
    <div class="pila">
      <div class="fila"><button class="btn chico" data-accion="volver">← Volver</button></div>
      <div class="tarjeta comanda ${claseEstado(c.estado)}" style="cursor:default">
        <div class="fila entre"><span class="num">Comanda #${c.numero_dia}</span>${badge(c.estado)}</div>
        <div class="fila envolver" style="margin-top:6px">${lugar(c)}
          ${c.pagada ? `<span class="etiqueta pagada">PAGADA${c.metodo_pago ? ` · ${esc(c.metodo_pago.toUpperCase())}` : ''}</span>` : ''}</div>
        <div class="suave peq">Mozo: ${esc(c.mozo_nombre || '-')} · Creada ${hora(c.creado_en)} · ${esc(c.fecha)}</div>
        <div class="tabla-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Cant.</th><th>Plato</th><th class="num">P. unit</th><th class="num">Subtotal</th></tr></thead>
          <tbody>${c.items
            .map((i) => {
              const g = detalleGuarnicion(i);
              return `<tr><td><b>${i.cantidad}</b></td><td>${esc(i.nombre)}${i.tipo === 'menu' ? ' <span class="etiqueta">MENÚ</span>' : ''}
                ${g ? `<div class="guar">${g}</div>` : ''}${i.nota ? `<div class="nota">${esc(i.nota)}</div>` : ''}</td>
                <td class="num">${dinero(i.precio)}</td><td class="num">${dinero(i.precio * i.cantidad)}</td></tr>`;
            })
            .join('')}</tbody>
          <tfoot><tr><th colspan="3">Total</th><th class="num" style="font-size:1.05rem;color:var(--texto)">${dinero(c.total)}</th></tr></tfoot>
        </table></div>
        ${c.nota ? `<div class="nota" style="margin-top:8px">📝 ${esc(c.nota)}</div>` : ''}
        <div class="acciones">${acciones.join('')}</div>
      </div>
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
  const [todasMesas, carta, existente] = await Promise.all([
    api('GET', '/api/mesas'),
    api('GET', '/api/carta'),
    editando ? api('GET', `/api/comandas/${r.param}`) : null,
  ]);
  // mesas unidas: se elige el grupo ("10-11"), que se guarda en la mesa principal
  const mesas = todasMesas.filter((m) => m.principal_id === m.id);
  const principalDe = (id) => todasMesas.find((m) => m.id === id)?.principal_id || null;
  // el menú se cobra a precio fijo, sea cual sea el segundo
  for (const p of carta.menu) p.precio = carta.precio_menu;
  const productos = [...carta.menu, ...carta.extras];
  const porId = new Map(productos.map((p) => [p.id, p]));
  const guarniciones = carta.guarniciones; // activas
  const guarPorId = new Map(guarniciones.map((g) => [g.id, g]));
  const delDia = guarniciones.filter((g) => g.del_dia);
  const habituales = guarniciones.filter((g) => g.eleccion_habitual);
  // a elección: las marcadas para el día; si no hay, las habituales; si tampoco, todas
  const opcionesEleccion = delDia.length ? delDia : habituales.length ? habituales : guarniciones;

  const b = {
    id: existente?.id || null,
    tipo: existente?.tipo || r.query.get('tipo') || (S.me.rol === 'caja' ? 'llevar' : 'local'),
    mesa_id: existente?.mesa_id || principalDe(Number(r.query.get('mesa'))),
    cliente: existente?.cliente || '',
    nota: existente?.nota || '',
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
  if (existente?.mesa_id && !mesas.find((m) => m.id === existente.mesa_id))
    mesas.push({ id: existente.mesa_id, numero: existente.mesa_numero, ocupada: true });

  const total = () => b.lineas.reduce((s, l) => s + (porId.get(l.producto_id)?.precio || 0) * l.cantidad, 0);
  const cantidadTotal = () => b.lineas.reduce((s, l) => s + l.cantidad, 0);
  const cantidadDe = (pid) => b.lineas.filter((l) => l.producto_id === pid).reduce((s, l) => s + l.cantidad, 0);
  const nombreG = (id) => guarPorId.get(id)?.nombre || '';
  const mismaConfig = (a, c) => a.producto_id === c.producto_id && a.base === c.base && a.eleccion === c.eleccion && (a.nota || '') === (c.nota || '');

  function textoLinea(l) {
    const p = porId.get(l.producto_id);
    const partes = p.tipo === 'menu' && carta.sopa ? [`Sopa: ${esc(carta.sopa.nombre)}`] : [];
    if (p.guarnicion_base_id) {
      if (!l.base) partes.push(`<b>sin ${esc(p.guarnicion_base.toLowerCase())}</b>`);
      else if (l.base !== p.guarnicion_base_id) partes.push(`<b>${esc(nombreG(l.base))}</b> (cambio)`);
      else partes.push(esc(p.guarnicion_base));
    }
    if (p.con_eleccion) partes.push(l.eleccion ? esc(nombreG(l.eleccion)) : '<span class="falta">sin guarnición a elección</span>');
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
    const m = abrirModal(`
      <div class="pila">
        <div class="fila entre"><h3>${esc(p.nombre)}</h3><button class="btn chico" data-x>✕</button></div>
        <div class="suave">${dinero(p.precio)}${p.tipo === 'menu' && carta.sopa ? ` · menú con sopa: ${esc(carta.sopa.nombre)}` : ''}</div>
        <div><div class="etiqueta-campo">Guarnición (${p.guarnicion_base_id ? `por defecto: ${esc(p.guarnicion_base)}` : 'opcional'})</div>
          <div class="opciones">${opcionesBase
            .map((g) => `<button type="button" class="chip ${g.id === base ? 'activo' : ''}" data-base="${g.id}">${esc(g.nombre)}</button>`)
            .join('')}<button type="button" class="chip ${!base ? 'activo' : ''}" data-base="">Sin guarnición</button></div></div>
        ${
          p.con_eleccion
            ? `<div><div class="etiqueta-campo">Guarnición a elección${delDia.length ? ' (de hoy)' : ''}</div>
               <div class="opciones">${opcionesEleccion
                 .map((g) => `<button type="button" class="chip ${g.id === eleccion ? 'activo' : ''}" data-eleccion="${g.id}">${esc(g.nombre)}</button>`)
                 .join('')}<button type="button" class="chip ${idx != null && !eleccion ? 'activo' : ''}" data-eleccion="0">Ninguna</button></div></div>`
            : ''
        }
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
  let pestana = carta.menu.length ? 'menu' : 'extra';
  let categoria = 'todos';
  let busqueda = '';
  const mesaSel = () => mesas.find((m) => m.id === b.mesa_id);
  const vendible = (p) => (b.tipo === 'local' ? p.para_local : p.para_llevar);

  function tarjetaPlato(p) {
    const n = cantidadDe(p.id);
    const guar = [p.guarnicion_base ? `con ${p.guarnicion_base.toLowerCase()}` : '', p.con_eleccion ? '+ a elección' : ''].filter(Boolean).join(' ');
    return `
      <button type="button" class="plato ${!p.disponible ? 'sin-stock' : ''}" data-mas="${p.id}" data-pid="${p.id}" ${!p.disponible ? 'disabled' : ''}>
        <span class="cuenta ${n ? '' : 'oculto'}">${n}</span>
        <span class="fila entre"><b>${esc(p.nombre)}</b>${!p.disponible ? '<span class="insignia no">Agotado</span>' : ''}</span>
        <small class="suave desc">${esc(p.descripcion)}</small>
        <span class="pie"><b class="precio">${dinero(p.precio)}</b><small class="suave">${esc(guar)}</small></span>
      </button>`;
  }

  function pintarCarta() {
    const deCarta = (pestana === 'menu' ? carta.menu : carta.extras).filter(vendible);
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
        ? `<div class="suave" style="grid-column:1/-1">🍲 Sopa: <b>${esc(carta.sopa.nombre)}</b> · Menú ${dinero(carta.precio_menu)} — elija el segundo</div>`
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
        render();
      };
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

  // La precuenta sale de lo guardado: de la mesa entera, o de esta comanda si es para llevar
  async function precuenta() {
    if (JSON.stringify(b.lineas) !== lineasGuardadas) return toast('Guarde los cambios antes de imprimir la precuenta', 'error');
    const ventana = usaTicketeraCaja() ? null : prepararVentana(); // antes del await, para que el celular no bloquee la ventana
    try {
      const ids =
        b.tipo === 'local' && b.mesa_id
          ? (await api('GET', '/api/comandas?vista=por_cobrar')).filter((c) => c.mesa_id === b.mesa_id).map((c) => c.id)
          : b.id ? [b.id] : [];
      if (!ids.length) throw new Error('Todavía no hay comandas guardadas para la precuenta');
      if (usaTicketeraCaja()) aTicketera('/api/imprimir/precuenta', { ids }, 'Precuenta enviada a la ticketera');
      else imprimirPDF(`/api/precuenta.pdf?ids=${ids.join(',')}`, ventana);
    } catch (e) {
      ventana?.close();
      toast(e.message, 'error');
    }
  }

  async function guardar(enviar) {
    if (b.tipo === 'local' && !b.mesa_id) return toast('Seleccione una mesa', 'error');
    if (!b.lineas.length) return toast('Agregue al menos un plato', 'error');
    const cuerpo = {
      tipo: b.tipo,
      mesa_id: b.tipo === 'local' ? b.mesa_id : null,
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
  const rol = S.me.rol;
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
  const editar = rol === 'admin' && S.salonEditar;
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
              ${rol === 'admin' && !editar && !unir ? '<button class="btn chico" id="modo-editar">✏️ Editar plano</button>' : ''}
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
        const total = cs.reduce((s, c) => s + c.total, 0);
        const modal = abrirModal(`
          <div class="pila">
            <div class="fila entre"><h3>Mesa ${esc(p.etiqueta)} <span class="suave peq">· ${esc(p.piso)}</span></h3><button class="btn chico" data-x>✕</button></div>
            <div class="suave">${cs.length ? `Consumo: <b>${dinero(total)}</b>` : 'Libre'}</div>
            ${cs.length && puede('admin', 'caja') ? `<button class="btn acento bloque" id="cobrar-mesa">💵 Cobrar mesa completa (${dinero(total)})</button>` : ''}
            ${cs.length ? `<button class="btn bloque" id="precuenta-mesa">🧾 Precuenta (${dinero(total)})</button>` : ''}
            ${cs.map(tarjetaComanda).join('')}
            <button class="btn primario bloque" data-accion="nueva-comanda" data-mesa="${p.id}">＋ ${cs.length ? 'Agregar otra comanda' : 'Nueva comanda'}</button>
            ${separar}
          </div>`);
        $('[data-x]', modal).onclick = cerrarModal;
        const cm = $('#cobrar-mesa', modal);
        if (cm) cm.onclick = () => abrirCobro(cs, `Cobrar mesa ${p.etiqueta}`);
        const pc = $('#precuenta-mesa', modal);
        if (pc)
          pc.onclick = () =>
            usaTicketeraCaja()
              ? aTicketera('/api/imprimir/precuenta', { ids: cs.map((c) => c.id) }, 'Precuenta enviada a la ticketera')
              : imprimirPDF(`/api/precuenta.pdf?ids=${cs.map((c) => c.id).join(',')}`);
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
  const todos = [...carta.sopas, ...carta.menu, ...carta.extras];
  const lista = todos.filter((p) => f === 'todas' || p.tipo === f);
  const delDia = carta.guarniciones.filter((g) => g.activo && g.del_dia);
  const aEleccion = (delDia.length ? delDia : carta.guarniciones.filter((g) => g.activo && g.eleccion_habitual)).map((g) => g.nombre);
  const menuHoy = carta.sopa ? carta.menu.filter((p) => p.activo && p.en_carta).length : 0;
  const extrasActivos = carta.extras.filter((p) => p.activo).length;
  // Estado: sopa / segundo variable = "sale hoy"; segundo fijo y extras = activo
  const delDiaMenu = (p) => p.tipo === 'menu' && p.menu_rol !== 'fijo';
  const encendido = (p) => (delDiaMenu(p) ? p.en_carta && p.activo : p.activo);
  const interruptor = (p) =>
    admin
      ? `<button class="interruptor ${encendido(p) ? 'on' : ''}" data-estado-plato="${p.id}" role="switch" aria-checked="${encendido(p) ? 'true' : 'false'}"
           aria-label="${delDiaMenu(p) ? 'Sale hoy' : 'Activo'}: ${esc(p.nombre)}"></button>`
      : '';
  const guarnicion = (p) =>
    p.guarnicion_base || p.con_eleccion
      ? `${p.guarnicion_base ? esc(p.guarnicion_base) : '—'}<div class="suave peq">${p.con_eleccion ? '+ 1 a elección (sin costo)' : 'cambiable'}</div>`
      : '<span class="suave">Sin guarnición</span>';
  const fila = (p) => `
    <tr data-buscar="${esc((p.nombre + ' ' + p.categoria + ' ' + p.descripcion).toLowerCase())}" class="${encendido(p) ? '' : 'apagado'}">
      <td><b>${esc(p.nombre)}</b>${p.descripcion ? `<div class="suave peq recorte">${esc(p.descripcion)}</div>` : ''}</td>
      <td>${p.tipo === 'menu' ? `Menú · ${ROL_MENU[p.menu_rol]}` : 'Extras'}<div class="suave peq">${esc(p.categoria)}</div></td>
      <td>${guarnicion(p)}</td>
      <td class="num precio">${p.tipo === 'menu' ? `<span class="suave">menú ${dinero(carta.precio_menu)}</span>` : p.precio > 0 ? dinero(p.precio) : '<span class="suave">Sin precio</span>'}</td>
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
        ${tarjetaCarta('menu', 'Menú del día', carta.sopa ? `${dinero(carta.precio_menu)} · ${esc(carta.sopa.nombre)} + ${menuHoy} segundos` : 'Hoy sin menú (falta la sopa)')}
        ${tarjetaCarta('extra', 'Extras', `${extrasActivos} platos activos · carta fija`)}
        <div class="tarjeta carta-resumen"><b>A elección hoy</b><small class="suave">${esc(aEleccion.join(', ') || 'cualquier guarnición')}</small></div>
      </div>
      <div class="fila entre envolver">
        <div class="segmento compacto">${[['todas', 'Todas'], ['menu', 'Menú del día'], ['extra', 'Extras']]
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
      <p class="suave peq">Los extras llevan su guarnición por defecto; el cliente puede cambiarla y/o agregar una a elección sin costo adicional.</p>
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
  $('#nuevo', main).onclick = () => formularioPlato(null, { tipo: f === 'extra' ? 'extra' : 'variable' });
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
        ${tabla(['Plato', 'Tipo', '#Cant.', '#Total'], r.productos.map((p) => [esc(p.nombre), p.tipo === 'menu' ? 'Menú' : 'Extra', p.cantidad, dinero(p.total)]))}
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
  const tabs = [['carta', '📅 Carta del día'], ['platos', '🍲 Platos'], ['guarniciones', '🥗 Guarniciones'], ['mesas', '🍽️ Mesas'], ['usuarios', '👤 Usuarios'], ['impresora', '🖨️ Impresora']];
  main.innerHTML = `<div class="pila">${chips(tabs, S.adminTab, 'at')}<div id="admin-cont"></div></div>`;
  enlazarChips(main, 'at', (v) => {
    S.adminTab = v;
    vAdmin(main);
  });
  const cont = $('#admin-cont', main);
  await { carta: adminCarta, platos: adminPlatos, guarniciones: adminGuarniciones, mesas: adminMesas, usuarios: adminUsuarios, impresora: adminImpresora }[S.adminTab](cont);
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
const ROL_MENU = { sopa: 'Sopa', fijo: 'Segundo fijo', variable: 'Segundo variable' };
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
        ['extra', 'Extra (carta fija, precio propio)'],
      ],
      def: tipo || 'variable',
    },
    { n: 'precio', l: `Precio (${S.config.moneda}) — solo extras`, t: 'number', paso: '0.10', ayuda: 'Sopa y segundos del menú se cobran al precio fijo del menú.' },
    {
      n: 'guarnicion_base_id',
      l: 'Guarnición por defecto',
      t: 'select',
      op: [['', '— Sin guarnición —'], ...guarniciones.filter((g) => g.activo).map((g) => [g.id, g.nombre])],
      def: guarniciones.find((g) => g.activo && g.nombre.toLowerCase() === 'arroz')?.id ?? '',
      ayuda: 'El mozo la puede cambiar por otra al tomar el pedido.',
    },
    { n: 'con_eleccion', l: 'Lleva una guarnición a elección', t: 'check', def: true, ayuda: 'Ej: picante de lisas, kapchi… (las que se ofrecen ese día)' },
    { n: 'categoria', l: 'Categoría (para ordenar la carta)', lista: categorias, def: tipo === 'extra' ? 'Fondos' : 'Menú' },
    { n: 'para_local', l: 'Se sirve en mesa', t: 'check', def: true },
    { n: 'para_llevar', l: 'Se vende para llevar', t: 'check', def: true },
    { n: 'disponible', l: 'Hay stock (desmarcar = agotado)', t: 'check', def: true },
    { n: 'activo', l: 'Activo', t: 'check', def: true },
    { n: 'descripcion', l: 'Descripción (opcional)' },
  ];
  const f = formulario({
    titulo: p ? `Editar: ${p.nombre}` : 'Nuevo plato',
    campos,
    valores: p ? { ...p, tipo: p.tipo === 'menu' ? p.menu_rol : 'extra', guarnicion_base_id: p.guarnicion_base_id ?? '' } : {},
    enviar: (d) => {
      d = { ...d, tipo: d.tipo === 'extra' ? 'extra' : 'menu', menu_rol: d.tipo };
      return p ? api('PUT', `/api/productos/${p.id}`, d) : api('POST', '/api/productos', { ...d, agregar_a_fecha: fecha || true });
    },
    eliminar: p
      ? async () => {
          const r = await api('DELETE', `/api/productos/${p.id}`);
          cerrarModal();
          toast(r.desactivado ? 'El plato tiene ventas: se desactivó' : 'Plato eliminado', 'ok');
        }
      : null,
  });
  // precio solo para extras; la sopa del menú no lleva guarnición
  const el = f.elements;
  const ajustar = () => {
    el.precio.closest('label').style.display = el.tipo.value === 'extra' ? '' : 'none';
    const sopa = el.tipo.value === 'sopa';
    if (sopa) (el.guarnicion_base_id.value = ''), (el.con_eleccion.checked = false);
    el.guarnicion_base_id.disabled = el.con_eleccion.disabled = sopa;
  };
  el.tipo.onchange = ajustar;
  ajustar();
}

/** Carta del día: marcar qué platos y guarniciones salen */
async function adminCarta(cont) {
  const fecha = S.fechaCarta || fechaHoy();
  const carta = await api('GET', `/api/carta?fecha=${fecha}&completo=1`);
  const menu = carta.menu.filter((p) => p.activo);
  const fijos = menu.filter((p) => p.menu_rol === 'fijo');
  const variables = menu.filter((p) => p.menu_rol !== 'fijo');
  const sopas = carta.sopas.filter((p) => p.activo);
  const delDia = carta.guarniciones.filter((g) => g.activo && g.del_dia);
  const esHoy = fecha === fechaHoy();
  // los segundos fijos no se marcan: salen todos los días que hay menú
  const filaMenu = (p) => `
    <div class="toggle-fila ${p.en_carta ? 'on' : ''}">
      ${p.menu_rol === 'fijo' ? '' : `<button class="toggle" data-menu="${p.id}" data-v="${p.en_carta ? 0 : 1}" aria-pressed="${p.en_carta ? 'true' : 'false'}">${p.en_carta ? '✓' : ''}</button>`}
      <div class="crecer" ${p.menu_rol === 'fijo' ? '' : `data-menu-txt="${p.id}"`}>
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${[p.guarnicion_base ? `con ${esc(p.guarnicion_base.toLowerCase())}` : '', p.con_eleccion ? '+ a elección' : '', esc(p.descripcion)].filter(Boolean).join(' ') || '&nbsp;'}</div>
      </div>
      ${p.en_carta ? `<button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button>` : ''}
      <button class="btn chico" data-editar-plato="${p.id}" aria-label="Editar">✏️</button>
    </div>`;
  cont.innerHTML = `
    <div class="pila">
      <div class="tarjeta fila entre envolver">
        <div class="fila"><input type="date" class="entrada" id="fecha" value="${fecha}" style="width:auto">
          <span class="suave">${esHoy ? 'Hoy' : ''}</span></div>
        <button class="btn chico" id="copiar">📋 Copiar carta del día anterior</button>
      </div>
      <div class="tarjeta pila">
        <div class="fila entre envolver"><h3>📅 Menú de este día</h3>
          <form class="fila" id="form-precio-menu"><span>Precio del menú</span>
            <input class="entrada" name="precio" type="number" step="0.10" min="0" inputmode="decimal" value="${carta.precio_menu || ''}" style="width:100px" required>
            <button class="btn chico">Guardar</button></form></div>
        <p class="suave peq">El menú es una sopa + un segundo a elección, siempre al mismo precio. Los platos se crean una sola vez y se reutilizan.</p>
        <div class="fila entre"><h4>🍲 Sopa del día</h4><button class="btn chico" data-nuevo-menu="sopa">＋ Sopa</button></div>
        ${carta.sopa ? '' : '<div class="error">Sin sopa elegida este día no hay menú.</div>'}
        ${sopas.map(filaMenu).join('') || '<div class="suave">Aún no hay sopas. Cree la primera.</div>'}
        <div class="fila entre"><h4>📌 Segundos fijos (salen todos los días con menú)</h4><button class="btn chico" data-nuevo-menu="fijo">＋ Fijo</button></div>
        ${fijos.map(filaMenu).join('') || '<div class="suave">Sin segundos fijos.</div>'}
        <div class="fila entre"><h4>🔄 Segundos variables (marque los de este día)</h4><button class="btn chico" data-nuevo-menu="variable">＋ Variable</button></div>
        ${variables.map(filaMenu).join('') || '<div class="suave">Sin segundos variables.</div>'}
      </div>
      <div class="tarjeta">
        <div class="fila entre"><h3>🥗 Guarniciones a elección (${delDia.length})</h3></div>
        <p class="suave peq">Toque para marcar las que se ofrecen este día. Si no marca ninguna, se ofrecen las habituales
          (${esc(carta.guarniciones.filter((g) => g.activo && g.eleccion_habitual).map((g) => g.nombre).join(', ') || 'ninguna definida: todas')}).</p>
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
  $$('[data-menu]', cont).forEach((x) => (x.onclick = () => alternarMenu(Number(x.dataset.menu), x.dataset.v === '1')));
  $$('[data-menu-txt]', cont).forEach((x) => (x.onclick = () => $(`[data-menu="${x.dataset.menuTxt}"]`, cont).click()));
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
  $$('[data-editar-plato]', cont).forEach((x) => (x.onclick = () => formularioPlato([...menu, ...sopas].find((p) => p.id === Number(x.dataset.editarPlato)))));
  $('#form-precio-menu', cont).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/api/carta/precio-menu', { precio: Number(e.target.precio.value) });
      toast('Precio del menú guardado', 'ok');
      recargar();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  $('#ver-platos', cont).onclick = () => {
    S.adminTab = 'platos';
    S.filtroPlatos = 'extra';
    vAdmin($('#vista'));
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
      ${chips([['todos', 'Todos'], ['menu', 'Menú del día'], ['extra', 'Extras']], f, 'fp')}
      <input class="entrada" id="buscar" placeholder="🔎 Buscar…" autocomplete="off">
      <div class="lista-admin">${
        lista
          .map(
            (p) => `<div class="item" data-buscar="${esc(p.nombre.toLowerCase())}">
              <div class="crecer"><b>${esc(p.nombre)}</b> <span class="etiqueta">${p.tipo === 'menu' ? `MENÚ · ${ROL_MENU[p.menu_rol].toUpperCase()}` : 'EXTRA'}</span>
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
  $('#nuevo', cont).onclick = () => formularioPlato(null, { tipo: f === 'extra' ? 'extra' : 'variable' });
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
          (g) => `<div class="item"><div class="crecer"><b>${esc(g.nombre)}</b> ${g.eleccion_habitual ? '<span class="etiqueta pagada">A ELECCIÓN</span>' : ''} ${!g.activo ? '<span class="etiqueta">INACTIVA</span>' : ''}</div>
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
            { n: 'eleccion_habitual', l: 'Ofrecer a elección por defecto', t: 'check', ayuda: 'Se ofrece como guarnición a elección los días en que no se marquen otras.' },
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
