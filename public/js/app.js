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
  filtroMesas: 'todas',
  adminTab: 'carta',
  filtroPlatos: 'todos',
  fechaCarta: null,
  fechaReporte: null,
  audio: null,
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
  admin: ['mesas', 'comandas', 'tickets', 'reporte', 'admin'],
  mozo: ['mesas', 'comandas', 'carta'],
  caja: ['mesas', 'comandas', 'tickets', 'reporte'],
  cocina: ['tickets', 'carta'],
};
// [texto, grupo, icono (trazos SVG estilo lucide)]
const TAB_INFO = {
  mesas: ['Salón', 'Operaciones', '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>'],
  comandas: ['Pedidos / Comandas', 'Operaciones', '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>'],
  tickets: ['Cocina', 'Operaciones', '<path d="M17 21a1 1 0 0 0 1-1v-5.35c0-.46.32-.84.73-1.04a4 4 0 0 0-2.14-7.59 5 5 0 0 0-9.18 0 4 4 0 0 0-2.14 7.59c.41.2.73.58.73 1.04V20a1 1 0 0 0 1 1ZM6 17h12"/>'],
  carta: ['Carta del día', 'Catálogos', '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'],
  reporte: ['Reportes', 'Análisis', '<path d="M3 3v18h18M8 17V9M13 17V5M18 17v-3"/>'],
  admin: ['Configuración', 'Sistema', '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'],
};
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
const puede = (...roles) => S.me && roles.includes(S.me.rol);
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
      const el = f.elements[c.n];
      if (c.t === 'check') datos[c.n] = el.checked;
      else if (c.t === 'number') datos[c.n] = el.value === '' ? '' : Number(el.value);
      else datos[c.n] = el.value;
      if (c.req && (datos[c.n] === '' || datos[c.n] == null)) {
        err.textContent = `Complete: ${c.l}`;
        return;
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
  for (const ev of ['comandas', 'mesas', 'productos', 'turnos']) {
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
    sonar(3);
    toast(`🖨️ Ticket ${d.accion === 'editada' ? 'modificado' : 'nuevo'} #${d.numero} (${donde})`, 'aviso', 5000);
  }
}

async function actualizarContadores() {
  if (!S.me || !TABS[S.me.rol].includes('tickets')) return;
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
        <div class="logo">${esc(iniciales(S.config.nombreRestaurante))}</div>
        <h1>${esc(S.config.nombreRestaurante)}</h1>
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
  for (const id of TABS[rol]) (grupos[TAB_INFO[id][1]] ||= []).push(id);
  let colapsado = false;
  try {
    colapsado = localStorage.getItem('lateral') === 'colapsado';
  } catch {}
  $('#app').innerHTML = `
    <div class="app${colapsado ? ' colapsado' : ''}">
      <aside class="lateral">
        <div class="marca">
          <div class="logo">${esc(iniciales(S.config.nombreRestaurante))}</div>
          <div class="txt"><b>${esc(S.config.nombreRestaurante)}</b><small>${esc(S.config.direccion || 'Sistema de comandas')}</small></div>
        </div>
        <div class="rol-pill"><span class="txt">${ROL_TXT[rol]}</span><span class="punto" id="punto"></span></div>
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
          ${TABS[rol].includes('tickets') ? `<a class="campana" href="#/tickets" aria-label="Tickets pendientes">${svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/>')}<span class="contador oculto"></span></a>` : ''}
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
  if (!location.hash || location.hash === '#/') location.hash = `#/${TABS[S.me.rol][0]}`;
  else navegar();
  actualizarContadores();
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
  if (!def || !def.roles.includes(S.me.rol)) {
    location.hash = `#/${TABS[S.me.rol][0]}`;
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
function abrirCobro(comandas, titulo) {
  const total = comandas.reduce((s, c) => s + c.total, 0);
  const metodos = S.config.metodosPago || ['Efectivo'];
  let metodo = metodos[0];
  const m = abrirModal(`
    <div class="pila">
      <div class="fila entre"><h3>${esc(titulo)}</h3><button class="btn chico" data-x>✕</button></div>
      <div class="suave">${comandas.map((c) => `#${c.numero_dia}`).join(', ')}</div>
      <div class="total-cobro">${dinero(total)}</div>
      <div><div class="etiqueta-campo">Forma de pago</div>
        <div class="opciones">${metodos.map((x) => `<button type="button" class="chip ${x === metodo ? 'activo' : ''}" data-metodo="${esc(x)}">${esc(x)}</button>`).join('')}</div></div>
      <label class="campo" id="campo-recibido"><span>Recibido (opcional, para calcular el vuelto)</span>
        <input type="number" inputmode="decimal" step="0.1" min="0" id="recibido" placeholder="${Number(total).toFixed(2)}"></label>
      <div class="suave" id="vuelto"></div>
      <div class="error" data-err></div>
      <button class="btn acento bloque" id="cobrar">💵 Cobrar e imprimir comprobante</button>
    </div>`);
  $('[data-x]', m).onclick = cerrarModal;
  const recibido = $('#recibido', m);
  const vuelto = () => {
    const r = Number(recibido.value);
    $('#vuelto', m).textContent = recibido.value && r >= total ? `Vuelto: ${dinero(r - total)}` : '';
  };
  recibido.oninput = vuelto;
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
    e.target.disabled = true;
    const ventana = prepararVentana();
    try {
      const cobro = await api('POST', '/api/cobros', {
        comanda_ids: comandas.map((c) => c.id),
        metodo,
        recibido: metodo === 'Efectivo' && recibido.value !== '' ? Number(recibido.value) : null,
      });
      cerrarModal();
      toast(`Cobro registrado (${metodo})`, 'ok');
      imprimirPDF(`/api/cobros/${cobro.id}/comprobante.pdf`, ventana);
      recargarVista();
    } catch (err) {
      ventana?.close();
      $('[data-err]', m).textContent = err.message;
      e.target.disabled = false;
    }
  };
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
        <div class="suave">${ROL_TXT[S.me.rol]} · usuario <b>${esc(S.me.usuario)}</b></div>
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
  comprobante: (el) => imprimirPDF(`/api/cobros/${el.dataset.cobro}/comprobante.pdf`),
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
    ? `<b>Mesa ${esc(c.mesa_numero ?? '?')}</b>`
    : `<span class="etiqueta llevar">PARA LLEVAR</span>${c.cliente ? ` <b>${esc(c.cliente)}</b>` : ''}`;

/** Texto de guarniciones de un ítem de comanda */
function detalleGuarnicion(it) {
  const partes = [];
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
  if (c.pagada && c.cobro_id && ['admin', 'caja'].includes(rol)) {
    acciones.push(`<button class="btn chico" data-accion="comprobante" data-cobro="${c.cobro_id}">🧾 Comprobante</button>`);
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
  const [mesas, carta, existente] = await Promise.all([
    api('GET', '/api/mesas'),
    api('GET', '/api/carta'),
    editando ? api('GET', `/api/comandas/${r.param}`) : null,
  ]);
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
    tipo: existente?.tipo || (S.me.rol === 'caja' ? 'llevar' : 'local'),
    mesa_id: existente?.mesa_id || Number(r.query.get('mesa')) || null,
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
  if (r.query.get('mesa')) b.tipo = 'local';
  if (existente?.mesa_id && !mesas.find((m) => m.id === existente.mesa_id))
    mesas.push({ id: existente.mesa_id, numero: existente.mesa_numero, ocupada: true });

  const configurable = (p) => !!(p.guarnicion_base_id || p.con_eleccion);
  const total = () => b.lineas.reduce((s, l) => s + (porId.get(l.producto_id)?.precio || 0) * l.cantidad, 0);
  const cantidadTotal = () => b.lineas.reduce((s, l) => s + l.cantidad, 0);
  const cantidadDe = (pid) => b.lineas.filter((l) => l.producto_id === pid).reduce((s, l) => s + l.cantidad, 0);
  const nombreG = (id) => guarPorId.get(id)?.nombre || '';
  const mismaConfig = (a, c) => a.producto_id === c.producto_id && a.base === c.base && a.eleccion === c.eleccion && (a.nota || '') === (c.nota || '');

  function textoLinea(l) {
    const p = porId.get(l.producto_id);
    const partes = [];
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
        <div class="suave">${dinero(p.precio)}</div>
        ${
          p.guarnicion_base_id
            ? `<div><div class="etiqueta-campo">Guarnición (por defecto: ${esc(p.guarnicion_base)})</div>
               <div class="opciones">${opcionesBase
                 .map((g) => `<button type="button" class="chip ${g.id === base ? 'activo' : ''}" data-base="${g.id}">${esc(g.nombre)}</button>`)
                 .join('')}<button type="button" class="chip ${!base ? 'activo' : ''}" data-base="">Sin guarnición</button></div></div>`
            : ''
        }
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

  function filaProducto(p) {
    const ok = b.tipo === 'local' ? p.para_local : p.para_llevar;
    if (!ok) return '';
    const n = cantidadDe(p.id);
    const sub =
      [p.guarnicion_base ? `con ${esc(p.guarnicion_base.toLowerCase())}` : '', p.con_eleccion ? '+ guarnición a elección' : '']
        .filter(Boolean)
        .join(' ') || esc(p.descripcion.toLowerCase());
    return `
      <div class="producto ${!p.disponible ? 'sin-stock' : ''}" data-pid="${p.id}" data-buscar="${esc((p.nombre + ' ' + p.categoria).toLowerCase())}">
        <div class="info">
          <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
          <div class="suave peq">${dinero(p.precio)}${sub ? ` · ${sub}` : ''}</div>
        </div>
        <span class="cuenta ${n ? '' : 'oculto'}">${n}</span>
        <button type="button" class="btn-mas" data-mas="${p.id}" ${!p.disponible ? 'disabled' : ''} aria-label="Agregar ${esc(p.nombre)}">＋</button>
      </div>`;
  }

  function seccion(titulo, lista) {
    const filas = lista.map(filaProducto).join('');
    return filas ? `<div class="tarjeta"><h3>${titulo}</h3>${filas}</div>` : '';
  }

  function htmlPedido() {
    if (!b.lineas.length) return '<div class="suave">Todavía no hay platos. Tóquelos abajo para agregarlos.</div>';
    return b.lineas
      .map((l, i) => {
        const p = porId.get(l.producto_id);
        const det = textoLinea(l);
        return `<div class="linea-pedido">
          <div class="info" ${configurable(p) || l.nota !== undefined ? `data-editar-linea="${i}"` : ''}>
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
    $('#cant-pedido', main).textContent = cantidadTotal();
    $('#total', main).textContent = dinero(total());
    $('#cant', main).textContent = `${cantidadTotal()} plato(s)`;
    $$('.producto', main).forEach((f) => {
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
    const categorias = [...new Set(carta.extras.map((p) => p.categoria || 'Otros'))];
    const ordenMesas = [...mesas].sort((a, c) => (c.mozo_id === S.me.id) - (a.mozo_id === S.me.id));
    main.innerHTML = `
      <div class="pila con-barra">
        <div class="fila entre"><button class="btn chico" data-accion="volver">← Volver</button>
          <h2>${editando ? `Editar comanda #${existente.numero_dia}` : 'Nueva comanda'}</h2></div>
        <div class="segmento">
          <button type="button" data-tipo="local" class="${b.tipo === 'local' ? 'activo' : ''}">🍽️ En mesa</button>
          <button type="button" data-tipo="llevar" class="${b.tipo === 'llevar' ? 'activo' : ''}">🥡 Para llevar</button>
        </div>
        ${
          b.tipo === 'local'
            ? `<div class="tarjeta"><h3 style="margin-bottom:10px">Mesa</h3>
                ${
                  ordenMesas.length
                    ? `<div class="mesas-grid">${ordenMesas
                        .map(
                          (m) => `<button type="button" class="mesa-btn ${m.ocupada ? 'ocupada' : ''} ${m.id === b.mesa_id ? 'sel' : ''}" data-mesa="${m.id}">
                            <span class="n">${esc(m.numero)}</span><span class="s">${m.ocupada ? 'ocupada' : 'libre'}</span>
                            ${S.me.rol === 'mozo' && m.mozo_id === S.me.id ? '<span class="s">★ tuya</span>' : ''}</button>`
                        )
                        .join('')}</div>`
                    : '<div class="suave">No hay mesas registradas.</div>'
                }</div>`
            : `<div class="tarjeta"><label class="campo"><span>Nombre del cliente / referencia</span>
                <input id="cliente" value="${esc(b.cliente)}" placeholder="Ej: Juan, delivery 3…" autocomplete="off"></label></div>`
        }
        <div class="tarjeta pedido"><h3>🧾 Pedido (<span id="cant-pedido">${cantidadTotal()}</span>)</h3><div id="pedido">${htmlPedido()}</div></div>
        <input class="entrada" id="buscar" placeholder="🔎 Buscar plato…" autocomplete="off">
        ${seccion('📅 Menú del día', carta.menu) || '<div class="tarjeta suave">No hay menú del día cargado para hoy.</div>'}
        ${categorias.map((cat) => seccion(`⭐ Extras · ${esc(cat)}`, carta.extras.filter((p) => (p.categoria || 'Otros') === cat))).join('')}
        <div class="tarjeta"><label class="campo"><span>Nota general para cocina</span>
          <textarea id="nota" placeholder="Ej: alérgico al maní, servir todo junto…">${esc(b.nota)}</textarea></label></div>
      </div>
      <div class="barra-total"><div class="contenido">
        <div class="crecer"><div class="total" id="total">${dinero(total())}</div><div class="suave peq" id="cant">${cantidadTotal()} plato(s)</div></div>
        <button class="btn" id="guardar">Guardar</button>
        ${b.estadoOriginal === 'generado' ? '<button class="btn primario" id="enviar">Enviar a cocina</button>' : ''}
      </div></div>`;
    enlazar();
  }

  function enlazar() {
    $$('[data-tipo]', main).forEach(
      (el) =>
        (el.onclick = () => {
          b.tipo = el.dataset.tipo;
          b.lineas = b.lineas.filter((l) => {
            const p = porId.get(l.producto_id);
            return b.tipo === 'local' ? p.para_local : p.para_llevar;
          });
          render();
        })
    );
    $$('[data-mesa]', main).forEach(
      (el) =>
        (el.onclick = () => {
          b.mesa_id = Number(el.dataset.mesa);
          $$('[data-mesa]', main).forEach((x) => x.classList.toggle('sel', x === el));
        })
    );
    $$('[data-mas]', main).forEach(
      (el) =>
        (el.onclick = () => {
          const p = porId.get(Number(el.dataset.mas));
          if (configurable(p)) return configurarPlato(p);
          agregarLinea({ producto_id: p.id, cantidad: 1, nota: '', base: null, eleccion: null });
          refrescar();
        })
    );
    enlazarPedido();
    const cli = $('#cliente', main);
    if (cli) cli.oninput = () => (b.cliente = cli.value);
    $('#nota', main).oninput = (e) => (b.nota = e.target.value);
    $('#buscar', main).oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      $$('.producto', main).forEach((f) => f.classList.toggle('oculto', q && !f.dataset.buscar.includes(q)));
    };
    $('#guardar', main).onclick = () => guardar(false);
    const env = $('#enviar', main);
    if (env) env.onclick = () => guardar(true);
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
    $$('.barra-total button', main).forEach((x) => (x.disabled = true));
    try {
      const c = b.id ? await api('PUT', `/api/comandas/${b.id}`, cuerpo) : await api('POST', '/api/comandas', cuerpo);
      toast(enviar ? `Comanda #${c.numero_dia} enviada a cocina` : `Comanda #${c.numero_dia} guardada`, 'ok');
      history.replaceState(null, '', '#/comandas');
      navegar();
    } catch (e) {
      toast(e.message, 'error', 4000);
      $$('.barra-total button', main).forEach((x) => (x.disabled = false));
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
  const auto = leerAuto() && imprimeDirecto();
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
      ${
        imprimeDirecto()
          ? `<label class="check tarjeta"><input type="checkbox" id="auto" ${auto ? 'checked' : ''}>
              Imprimir automáticamente cada ticket nuevo (deje esta pantalla abierta en la PC de la impresora)</label>`
          : '<div class="tarjeta suave peq">Al imprimir se abre el PDF del ticket: use la opción Imprimir del navegador. Para imprimir con un toque, use Chrome o Edge en la computadora de la impresora.</div>'
      }
      <h3>Por imprimir (${pendientes.length})</h3>
      ${pendientes.length ? `<div class="grid">${pendientes.map(ticket).join('')}</div>` : '<div class="vacio">No hay tickets pendientes. 👍</div>'}
      <h3>En cocina · ya impresos (${impresos.length})</h3>
      ${impresos.length ? `<div class="grid">${impresos.map(ticket).join('')}</div>` : '<div class="suave">Ninguno.</div>'}
    </div>`;
  const chk = $('#auto', main);
  if (chk) chk.onchange = () => guardarAuto(chk.checked);
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

// ---------- Mesas ----------
async function vMesas(main) {
  const rol = S.me.rol;
  const [mesas, comandas] = await Promise.all([api('GET', '/api/mesas'), api('GET', '/api/comandas?vista=por_cobrar')]);
  const soloMias = rol === 'mozo' && S.filtroMesas === 'mias';
  const visibles = mesas.filter((m) => m.activa && (!soloMias || m.mozo_id === S.me.id));
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>Mesas</h2>
        <span class="suave peq">${visibles.filter((m) => m.ocupada).length}/${visibles.length} ocupadas</span></div>
      ${rol === 'mozo' ? chips([['todas', 'Todas'], ['mias', 'Mis mesas']], S.filtroMesas, 'fm') : ''}
      <div class="fila envolver peq suave">
        <span class="fila"><span class="leyenda"></span> Libre</span>
        <span class="fila"><span class="leyenda ocupada"></span> Ocupada (hasta cobrar)</span>
        ${rol === 'mozo' ? '<span>★ asignada a ti</span>' : ''}
      </div>
      ${
        visibles.length
          ? `<div class="mesas-grid">${visibles
              .map(
                (m) => `<button class="mesa-btn ${m.ocupada ? 'ocupada' : ''}" data-m="${m.id}">
                  <span class="n">${esc(m.numero)}${rol === 'mozo' && m.mozo_id === S.me.id ? ' ★' : ''}</span>
                  <span class="s">${m.ocupada ? dinero(m.por_cobrar) : 'libre'}</span>
                  <span class="s">${esc(m.mozo_nombre || 'sin mozo')}</span>
                </button>`
              )
              .join('')}</div>`
          : '<div class="vacio">No hay mesas para mostrar.</div>'
      }
    </div>`;
  enlazarChips(main, 'fm', (v) => {
    S.filtroMesas = v;
    vMesas(main);
  });
  $$('[data-m]', main).forEach(
    (el) =>
      (el.onclick = () => {
        const m = mesas.find((x) => x.id === Number(el.dataset.m));
        const cs = comandas.filter((c) => c.mesa_id === m.id);
        if (!cs.length) return ir(`#/nueva?mesa=${m.id}`);
        const total = cs.reduce((s, c) => s + c.total, 0);
        const modal = abrirModal(`
          <div class="pila">
            <div class="fila entre"><h3>Mesa ${esc(m.numero)}</h3><button class="btn chico" data-x>✕</button></div>
            <div class="suave">Mozo: ${esc(m.mozo_nombre || '-')} · Capacidad ${m.capacidad} · Consumo: <b>${dinero(total)}</b></div>
            ${puede('admin', 'caja') ? `<button class="btn acento bloque" id="cobrar-mesa">💵 Cobrar mesa completa (${dinero(total)})</button>` : ''}
            ${cs.map(tarjetaComanda).join('')}
            <button class="btn primario bloque" data-accion="nueva-comanda" data-mesa="${m.id}">＋ Agregar otra comanda a esta mesa</button>
          </div>`);
        $('[data-x]', modal).onclick = cerrarModal;
        const cm = $('#cobrar-mesa', modal);
        if (cm) cm.onclick = () => abrirCobro(cs, `Cobrar mesa ${m.numero}`);
      })
  );
}

// ---------- Carta de hoy (consulta) ----------
async function vCarta(main) {
  const carta = await api('GET', '/api/carta');
  const puedeAgotar = puede('admin', 'cocina', 'caja');
  const fila = (p) => `
    <div class="producto">
      <div class="info">
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${p.guarnicion_base ? `con ${esc(p.guarnicion_base.toLowerCase())}` : ''}${p.con_eleccion ? ' + guarnición a elección' : ''}
          ${p.guarnicion_base || p.con_eleccion ? ' · ' : ''}${p.para_local ? '🍽️ Mesa ' : ''}${p.para_llevar ? '🥡 Llevar' : ''}</div>
      </div>
      <div class="der"><b>${dinero(p.precio)}</b>
        ${puedeAgotar ? `<div><button class="btn chico ${p.disponible ? 'peligro' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotado' : 'Hay'}</button></div>` : ''}
      </div>
    </div>`;
  const cats = [...new Set(carta.extras.map((p) => p.categoria || 'Otros'))];
  const delDia = carta.guarniciones.filter((g) => g.del_dia);
  const opciones = delDia.length ? delDia : carta.guarniciones.filter((g) => g.eleccion_habitual);
  main.innerHTML = `
    <div class="pila">
      <h2>Menú de hoy</h2>
      <div class="tarjeta"><h3>🥗 Guarniciones a elección de hoy</h3>
        <div class="opciones" style="margin-top:8px">${opciones.map((g) => `<span class="chip">${esc(g.nombre)}</span>`).join('') || '<span class="suave">No se definieron: se puede elegir cualquiera.</span>'}</div></div>
      <div class="tarjeta"><h3>📅 Menú del día</h3>${carta.menu.map(fila).join('') || '<div class="suave">Sin menú cargado hoy.</div>'}</div>
      ${cats.map((c) => `<div class="tarjeta"><h3>⭐ Extras · ${esc(c)}</h3>${carta.extras.filter((p) => (p.categoria || 'Otros') === c).map(fila).join('')}</div>`).join('')}
    </div>`;
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
  const tabs = [['carta', '📅 Carta del día'], ['platos', '🍲 Platos'], ['guarniciones', '🥗 Guarniciones'], ['mesas', '🍽️ Mesas'], ['usuarios', '👤 Usuarios']];
  main.innerHTML = `<div class="pila">${chips(tabs, S.adminTab, 'at')}<div id="admin-cont"></div></div>`;
  enlazarChips(main, 'at', (v) => {
    S.adminTab = v;
    vAdmin(main);
  });
  const cont = $('#admin-cont', main);
  await { carta: adminCarta, platos: adminPlatos, guarniciones: adminGuarniciones, mesas: adminMesas, usuarios: adminUsuarios }[S.adminTab](cont);
}

/** Formulario de plato (crear o editar) */
async function formularioPlato(p, { tipo, fecha } = {}) {
  const [guarniciones, productos] = await Promise.all([api('GET', '/api/guarniciones'), api('GET', '/api/productos')]);
  const categorias = [...new Set(productos.map((x) => x.categoria).filter(Boolean))];
  const campos = [
    { n: 'nombre', l: 'Nombre del plato', req: true },
    { n: 'tipo', l: 'Tipo', t: 'select', op: [['menu', 'Menú del día (se elige qué días sale)'], ['extra', 'Extra (carta fija, sale todos los días)']], def: tipo || 'menu' },
    { n: 'precio', l: `Precio (${S.config.moneda})`, t: 'number', paso: '0.10', req: true },
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
  formulario({
    titulo: p ? `Editar: ${p.nombre}` : 'Nuevo plato',
    campos,
    valores: p ? { ...p, guarnicion_base_id: p.guarnicion_base_id ?? '' } : {},
    enviar: (d) => (p ? api('PUT', `/api/productos/${p.id}`, d) : api('POST', '/api/productos', { ...d, agregar_a_fecha: fecha || true })),
    eliminar: p
      ? async () => {
          const r = await api('DELETE', `/api/productos/${p.id}`);
          cerrarModal();
          toast(r.desactivado ? 'El plato tiene ventas: se desactivó' : 'Plato eliminado', 'ok');
        }
      : null,
  });
}

/** Carta del día: marcar qué platos y guarniciones salen */
async function adminCarta(cont) {
  const fecha = S.fechaCarta || fechaHoy();
  const carta = await api('GET', `/api/carta?fecha=${fecha}&completo=1`);
  const menu = carta.menu.filter((p) => p.activo);
  const enCarta = menu.filter((p) => p.en_carta);
  const delDia = carta.guarniciones.filter((g) => g.activo && g.del_dia);
  const esHoy = fecha === fechaHoy();
  const filaMenu = (p) => `
    <div class="toggle-fila ${p.en_carta ? 'on' : ''}">
      <button class="toggle" data-menu="${p.id}" data-v="${p.en_carta ? 0 : 1}" aria-pressed="${p.en_carta ? 'true' : 'false'}">${p.en_carta ? '✓' : ''}</button>
      <div class="crecer" data-menu-txt="${p.id}">
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${dinero(p.precio)}${p.guarnicion_base ? ` · con ${esc(p.guarnicion_base.toLowerCase())}` : ''}${p.con_eleccion ? ' + a elección' : ''}</div>
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
      <div class="tarjeta">
        <div class="fila entre"><h3>📅 Menú de este día (${enCarta.length})</h3><button class="btn chico primario" id="nuevo-menu">＋ Plato nuevo</button></div>
        <p class="suave peq">Marque los platos que salen este día. Los platos se crean una sola vez y se reutilizan.</p>
        ${menu.map(filaMenu).join('') || '<div class="suave">Aún no hay platos de menú. Cree el primero.</div>'}
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
  $('#nuevo-menu', cont).onclick = () => formularioPlato(null, { tipo: 'menu', fecha });
  $$('[data-editar-plato]', cont).forEach((x) => (x.onclick = () => formularioPlato(menu.find((p) => p.id === Number(x.dataset.editarPlato)))));
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
              <div class="crecer"><b>${esc(p.nombre)}</b> <span class="etiqueta">${p.tipo === 'menu' ? 'MENÚ' : 'EXTRA'}</span>
                ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''} ${!p.activo ? '<span class="etiqueta">INACTIVO</span>' : ''}
                <div class="suave peq">${dinero(p.precio)} · ${esc(p.categoria)}${p.guarnicion_base ? ` · con ${esc(p.guarnicion_base.toLowerCase())}` : ''}${p.con_eleccion ? ' + a elección' : ''}</div></div>
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
  $('#nuevo', cont).onclick = () => formularioPlato(null, { tipo: f === 'extra' ? 'extra' : 'menu' });
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
    { n: 'rol', l: 'Rol', t: 'select', op: Object.entries(ROL_TXT), def: 'mozo' },
    { n: 'activo', l: 'Activo (puede ingresar)', t: 'check', def: true },
  ];
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="fila entre"><h3>Usuarios (${us.length})</h3><button class="btn chico primario" id="nuevo">＋ Nuevo</button></div>
      <div class="lista-admin">${us
        .map(
          (u) => `<div class="item">
            <div class="crecer"><b>${esc(u.nombre)}</b> ${u.en_turno ? '<span class="etiqueta pagada">EN TURNO</span>' : ''} ${!u.activo ? '<span class="etiqueta agotado">INACTIVO</span>' : ''}
              <div class="suave peq">${esc(u.usuario)} · ${ROL_TXT[u.rol]}${u.rol === 'mozo' ? ` · ${u.mesas_asignadas} mesa(s)` : ''}</div></div>
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
          valores: { ...u, pin: '' },
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
  const [mesas, mozos] = await Promise.all([api('GET', '/api/mesas'), api('GET', '/api/mozos')]);
  const campos = [
    { n: 'numero', l: 'Número o nombre de mesa', req: true },
    { n: 'capacidad', l: 'Capacidad (personas)', t: 'number', paso: '1', def: 4 },
    { n: 'mozo_id', l: 'Mozo asignado', t: 'select', op: [['', '— Sin asignar —'], ...mozos.map((m) => [m.id, m.nombre])] },
    { n: 'activa', l: 'Activa', t: 'check', def: true },
  ];
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="fila entre"><h3>Mesas (${mesas.length})</h3><button class="btn chico primario" id="nuevo">＋ Nueva</button></div>
      <p class="suave peq">Cada mesa tiene un mozo a cargo, pero cualquier mozo puede tomar pedidos en cualquier mesa.</p>
      <div class="lista-admin">${mesas
        .map(
          (m) => `<div class="item">
            <div class="crecer"><b>Mesa ${esc(m.numero)}</b> ${m.ocupada ? '<span class="etiqueta llevar">OCUPADA</span>' : ''} ${!m.activa ? '<span class="etiqueta agotado">INACTIVA</span>' : ''}
              <div class="suave peq">${m.capacidad} personas</div></div>
            <select class="entrada" style="width:auto;max-width:45%" data-asignar="${m.id}">
              <option value="">Sin mozo</option>${mozos.map((z) => `<option value="${z.id}" ${z.id === m.mozo_id ? 'selected' : ''}>${esc(z.nombre)}</option>`).join('')}
            </select>
            <button class="btn chico" data-edit="${m.id}">✏️</button></div>`
        )
        .join('')}</div>
    </div>`;
  $('#nuevo', cont).onclick = () => formulario({ titulo: 'Nueva mesa', campos, enviar: (d) => api('POST', '/api/mesas', d) });
  $$('[data-asignar]', cont).forEach(
    (s) =>
      (s.onchange = async () => {
        const m = mesas.find((x) => x.id === Number(s.dataset.asignar));
        try {
          await api('PUT', `/api/mesas/${m.id}`, { ...m, mozo_id: s.value || null });
          toast(`Mesa ${m.numero} asignada`, 'ok', 1500);
        } catch (e) {
          toast(e.message, 'error');
        }
      })
  );
  $$('[data-edit]', cont).forEach(
    (b) =>
      (b.onclick = () => {
        const m = mesas.find((x) => x.id === Number(b.dataset.edit));
        formulario({
          titulo: `Mesa ${m.numero}`,
          campos,
          valores: { ...m, mozo_id: m.mozo_id ?? '' },
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
