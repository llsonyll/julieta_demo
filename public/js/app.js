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
  config: { moneda: 'S/', nombreRestaurante: 'Comandas' },
  desfase: 0, // diferencia de reloj entre servidor y celular (ms)
  sse: null,
  vista: null, // { nombre, recargar, escucha: [] }
  timers: [],
  filtroComandas: 'activas',
  filtroMesas: 'mias',
  adminTab: 'usuarios',
  fechaMenu: null,
  fechaReporte: null,
  borrador: null,
  audio: null,
};

const ESTADO_TXT = {
  generado: 'Generado',
  enviado_cocina: 'Enviado a cocina',
  en_proceso: 'En proceso',
  esperando_entrega: 'Esperando entrega',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const ROL_TXT = { admin: 'Administrador', mozo: 'Mozo', caja: 'Caja', cocina: 'Cocina' };
const TABS = {
  admin: [['comandas', '📋', 'Comandas'], ['cocina', '🍳', 'Cocina'], ['mesas', '🍽️', 'Mesas'], ['reporte', '📊', 'Reporte'], ['admin', '⚙️', 'Gestión']],
  mozo: [['comandas', '📋', 'Comandas'], ['mesas', '🍽️', 'Mis mesas'], ['carta', '📖', 'Menú']],
  caja: [['comandas', '📋', 'Comandas'], ['mesas', '🍽️', 'Mesas'], ['reporte', '📊', 'Reporte']],
  cocina: [['cocina', '🍳', 'Cocina'], ['carta', '📖', 'Platos']],
};

const dinero = (n) => `${S.config.moneda} ${Number(n || 0).toFixed(2)}`;
const hora = (s) => (s ? String(s).slice(11, 16) : '');
const parseFecha = (s) => new Date(String(s).replace(' ', 'T'));
const ahoraServidor = () => Date.now() + S.desfase;
const minutosDesde = (s) => (s ? Math.max(0, Math.floor((ahoraServidor() - parseFecha(s).getTime()) / 60000)) : 0);
function fechaHoy() {
  const d = new Date(ahoraServidor());
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}
const puede = (...roles) => S.me && roles.includes(S.me.rol);

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
    if (!S.audio) return;
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
  if (primero && !matchMedia('(pointer: coarse)').matches) primero.focus();
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

function pedirTexto(titulo, valor = '', placeholder = '') {
  return new Promise((resolve) => {
    const m = abrirModal(`
      <form class="pila">
        <h3>${esc(titulo)}</h3>
        <input class="entrada" name="t" value="${esc(valor)}" placeholder="${esc(placeholder)}" maxlength="150" autocomplete="off">
        <div class="fila"><button type="button" class="btn crecer" data-x>Cancelar</button>
        <button class="btn primario crecer">Aceptar</button></div>
      </form>`);
    const f = $('form', m);
    $('input', f).focus();
    $('[data-x]', m).onclick = () => (cerrarModal(), resolve(null));
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = f.t.value.trim();
      cerrarModal();
      resolve(v);
    };
  });
}

/**
 * Formulario genérico en modal.
 * campos: [{ n, l, t: text|number|password|select|check|textarea|date, op: [[valor, texto]], req, ayuda, paso }]
 */
function formulario({ titulo, campos, valores = {}, enviar, eliminar }) {
  const html = campos
    .map((c) => {
      const v = valores[c.n] ?? c.def ?? '';
      if (c.t === 'check')
        return `<label class="check"><input type="checkbox" name="${c.n}" ${v ? 'checked' : ''}> ${esc(c.l)}</label>`;
      let control;
      if (c.t === 'select')
        control = `<select name="${c.n}" ${c.req ? 'required' : ''}>${c.op
          .map(([ov, ot]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ot)}</option>`)
          .join('')}</select>`;
      else if (c.t === 'textarea') control = `<textarea name="${c.n}">${esc(v)}</textarea>`;
      else
        control = `<input name="${c.n}" type="${c.t || 'text'}" value="${esc(v)}" ${c.req ? 'required' : ''}
          ${c.t === 'number' ? `step="${c.paso || 'any'}" min="0" inputmode="decimal"` : ''} autocomplete="off">`;
      return `<label class="campo"><span>${esc(c.l)}</span>${control}${c.ayuda ? `<small class="suave">${esc(c.ayuda)}</small>` : ''}</label>`;
    })
    .join('');
  const m = abrirModal(`
    <form class="pila" novalidate>
      <div class="fila entre"><h3>${esc(titulo)}</h3><button type="button" class="btn chico" data-x>✕</button></div>
      ${html}
      <div class="error" data-err></div>
      <div class="fila">
        ${eliminar ? '<button type="button" class="btn peligro" data-del>Eliminar</button>' : ''}
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

function notificar(d) {
  if (!S.me || d.accion === 'eliminada') return;
  const rol = S.me.rol;
  const donde = d.tipo === 'llevar' ? 'para llevar' : `mesa ${d.mesa}`;
  if (d.estado === 'enviado_cocina' && (rol === 'cocina' || (rol === 'admin' && S.vista?.nombre === 'cocina'))) {
    if (d.accion !== 'editada') {
      sonar(3);
      toast(`🔔 Nueva comanda #${d.numero} (${donde})`, 'aviso', 5000);
    }
  }
  if (d.estado === 'esperando_entrega' && d.accion === 'estado') {
    if ((rol === 'mozo' && d.mozo_id === S.me.id) || (rol === 'caja' && d.tipo === 'llevar')) {
      sonar(2);
      toast(`🍽️ Comanda #${d.numero} lista — ${donde}`, 'aviso', 7000);
    }
  }
}

async function actualizarContadores() {
  if (!S.me) return;
  try {
    const rol = S.me.rol;
    const lista = await api('GET', `/api/comandas?vista=${rol === 'cocina' ? 'cocina' : 'activas'}`);
    const poner = (tab, n) => {
      const el = $(`.nav a[data-tab="${tab}"] .contador`);
      if (el) {
        el.textContent = n;
        el.classList.toggle('oculto', !n);
      }
    };
    poner('cocina', lista.filter((c) => c.estado === 'enviado_cocina').length);
    poner('comandas', lista.filter((c) => c.estado === 'esperando_entrega').length);
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  if (!S.sse || S.sse.readyState === EventSource.CLOSED) abrirSSE();
  recargarVista();
  actualizarContadores();
});

// ---------------- login y estructura ----------------
function renderLogin(mensaje = '') {
  cerrarModal();
  $('#app').innerHTML = `
    <div class="login">
      <form class="tarjeta pila" id="form-login">
        <div>
          <h1>🍽️ ${esc(S.config.nombreRestaurante)}</h1>
          <div class="suave">Sistema de comandas</div>
        </div>
        <label class="campo"><span>Usuario</span><input name="usuario" autocomplete="username" autocapitalize="none" required></label>
        <label class="campo"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="error">${esc(mensaje)}</div>
        <button class="btn primario bloque">Ingresar e iniciar turno</button>
      </form>
    </div>`;
  const f = $('#form-login');
  f.onsubmit = async (e) => {
    e.preventDefault();
    desbloquearAudio();
    const btn = $('button', f);
    btn.disabled = true;
    try {
      S.me = await api('POST', '/api/login', { usuario: f.usuario.value, password: f.password.value });
      iniciarApp();
    } catch (err) {
      $('.error', f).textContent = err.message;
      btn.disabled = false;
    }
  };
}

function renderShell() {
  const tabs = TABS[S.me.rol] || [];
  $('#app').innerHTML = `
    <header class="cabecera">
      <span class="punto" id="punto"></span>
      <div class="crecer">
        <div class="titulo">${esc(S.config.nombreRestaurante)}</div>
        <div class="usuario">${esc(S.me.nombre)} · ${ROL_TXT[S.me.rol]}</div>
      </div>
      <button class="btn-icono" data-accion="menu-usuario" aria-label="Menú de usuario">☰</button>
    </header>
    <main id="vista"></main>
    <nav class="nav">
      ${tabs
        .map(
          ([id, ico, txt]) =>
            `<a href="#/${id}" data-tab="${id}"><span class="ico">${ico}</span>${esc(txt)}<span class="contador oculto"></span></a>`
        )
        .join('')}
    </nav>`;
}

function iniciarApp() {
  renderShell();
  abrirSSE();
  if (!location.hash || location.hash === '#/') location.hash = `#/${TABS[S.me.rol][0][0]}`;
  else navegar();
  actualizarContadores();
}

// ---------------- enrutador ----------------
const VISTAS = {
  comandas: { roles: ['admin', 'mozo', 'caja'], fn: vComandas, escucha: ['comandas'] },
  comanda: { roles: ['admin', 'mozo', 'caja', 'cocina'], fn: vComandaDetalle, escucha: ['comandas'] },
  nueva: { roles: ['admin', 'mozo', 'caja'], fn: vEditorComanda, escucha: [] },
  editar: { roles: ['admin', 'mozo', 'caja'], fn: vEditorComanda, escucha: [] },
  cocina: { roles: ['admin', 'cocina'], fn: vCocina, escucha: ['comandas'] },
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
    location.hash = `#/${TABS[S.me.rol][0][0]}`;
    return;
  }
  const tabActivo = { comanda: 'comandas', nueva: 'comandas', editar: 'comandas' }[r.nombre] || r.nombre;
  $$('.nav a').forEach((a) => a.classList.toggle('activo', a.dataset.tab === tabActivo));
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

// ---------------- acciones (delegación de clicks) ----------------
const ACCIONES = {
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
      toast(`Comanda → ${ESTADO_TXT[estado]}`, 'ok', 1800);
      recargarVista();
    } catch (e) {
      toast(e.message, 'error');
      el.disabled = false;
    }
  },
  pago: async (el) => {
    const pagada = el.dataset.pagada === '1';
    if (pagada && !(await confirmar(`¿Registrar cobro de ${el.dataset.total}?`, { ok: 'Cobrado' }))) return;
    try {
      await api('POST', `/api/comandas/${el.dataset.id}/pago`, { pagada });
      toast(pagada ? 'Cobro registrado' : 'Cobro anulado', 'ok');
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
const badge = (estado) => `<span class="estado ${estado}">${ESTADO_TXT[estado]}</span>`;
const lugar = (c) =>
  c.tipo === 'local'
    ? `<b>Mesa ${esc(c.mesa_numero ?? '?')}</b>`
    : `<span class="etiqueta llevar">PARA LLEVAR</span>${c.cliente ? ` <b>${esc(c.cliente)}</b>` : ''}`;

function botonesComanda(c, contexto = 'sala') {
  const b = [];
  const rol = S.me.rol;
  const btn = (estado, texto, clase = '') =>
    `<button class="btn chico ${clase}" data-accion="estado" data-id="${c.id}" data-estado="${estado}">${texto}</button>`;
  if (contexto === 'cocina') {
    if (c.estado === 'enviado_cocina') b.push(btn('en_proceso', '👨‍🍳 Empezar', 'acento'));
    if (c.estado === 'en_proceso') b.push(btn('esperando_entrega', '✅ ¡Listo!', 'ok'));
    if (c.estado === 'esperando_entrega') b.push(btn('en_proceso', '↩ Volver a proceso'));
    return b.join('');
  }
  if (c.estado === 'generado' && ['admin', 'mozo', 'caja'].includes(rol)) {
    b.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar</button>`);
    b.push(btn('enviado_cocina', '🍳 Enviar a cocina', 'primario'));
  }
  if (c.estado === 'esperando_entrega' && ['admin', 'mozo', 'caja'].includes(rol)) b.push(btn('entregado', '🍽️ Entregado', 'ok'));
  if (['admin', 'caja'].includes(rol) && !c.pagada && c.estado !== 'cancelado')
    b.push(
      `<button class="btn chico acento" data-accion="pago" data-id="${c.id}" data-pagada="1" data-total="${esc(dinero(c.total))}">💵 Cobrar</button>`
    );
  return b.join('');
}

function tarjetaComanda(c) {
  return `
    <div class="tarjeta comanda ${c.estado}" data-accion="ver-comanda" data-id="${c.id}">
      <div class="fila entre"><span class="num">#${c.numero_dia}</span>${badge(c.estado)}</div>
      <div class="fila envolver" style="margin-top:4px">${lugar(c)}
        <span class="suave peq">· ${esc(c.mozo_nombre || '')} · ${hora(c.creado_en)}</span>
        ${c.pagada ? '<span class="etiqueta pagada">PAGADA</span>' : ''}</div>
      <ul class="items">${c.items
        .map((i) => `<li>${i.cantidad}× ${esc(i.nombre)}${i.nota ? ` <span class="suave">(${esc(i.nota)})</span>` : ''}</li>`)
        .join('')}</ul>
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
  const filtros = [['activas', 'Activas'], ...(rol !== 'mozo' ? [['por_cobrar', 'Por cobrar']] : []), ['todas', 'Todas de hoy']];
  const f = S.filtroComandas;
  const lista = await api('GET', `/api/comandas${f === 'todas' ? '' : `?vista=${f}`}`);
  const listas = lista.filter((c) => c.estado === 'esperando_entrega').length;
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>${rol === 'mozo' ? 'Mis comandas' : 'Comandas'}</h2>
        <span class="suave peq">${lista.length} ${lista.length === 1 ? 'comanda' : 'comandas'}</span></div>
      ${chips(filtros, f, 'filtro')}
      ${listas ? `<div class="tarjeta" style="background:#e8f8ee;border-color:#6fcf97">🍽️ <b>${listas}</b> lista(s) para entregar</div>` : ''}
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
  if (rol === 'cocina' || (rol === 'admin' && ['enviado_cocina', 'en_proceso'].includes(c.estado)))
    acciones.push(botonesComanda(c, 'cocina'));
  if (rol !== 'cocina') acciones.push(botonesComanda(c));
  const puedeCancelar =
    (c.estado === 'generado' && ['mozo', 'caja', 'admin'].includes(rol)) ||
    (c.estado === 'enviado_cocina' && ['caja', 'admin'].includes(rol)) ||
    (rol === 'admin' && !['entregado', 'cancelado'].includes(c.estado));
  if (puedeCancelar)
    acciones.push(`<button class="btn chico peligro" data-accion="estado" data-id="${c.id}" data-estado="cancelado">Cancelar comanda</button>`);
  if (rol === 'admin' && c.estado !== 'generado' && !['entregado', 'cancelado'].includes(c.estado))
    acciones.push(`<button class="btn chico" data-accion="editar-comanda" data-id="${c.id}">✏️ Editar (admin)</button>`);
  if (['admin', 'caja'].includes(rol) && c.pagada)
    acciones.push(`<button class="btn chico" data-accion="pago" data-id="${c.id}" data-pagada="0">Anular cobro</button>`);
  if (rol === 'admin') acciones.push(`<button class="btn chico peligro" data-accion="eliminar-comanda" data-id="${c.id}">🗑 Eliminar</button>`);

  main.innerHTML = `
    <div class="pila">
      <div class="fila"><button class="btn chico" data-accion="volver">← Volver</button></div>
      <div class="tarjeta comanda ${c.estado}" style="cursor:default">
        <div class="fila entre"><span class="num">Comanda #${c.numero_dia}</span>${badge(c.estado)}</div>
        <div class="fila envolver" style="margin-top:6px">${lugar(c)} ${c.pagada ? '<span class="etiqueta pagada">PAGADA</span>' : ''}</div>
        <div class="suave peq">Mozo: ${esc(c.mozo_nombre || '-')} · Creada ${hora(c.creado_en)} · ${esc(c.fecha)}</div>
        <div class="tabla-wrap" style="margin-top:10px"><table>
          <thead><tr><th>Cant.</th><th>Plato</th><th class="num">P. unit</th><th class="num">Subtotal</th></tr></thead>
          <tbody>${c.items
            .map(
              (i) => `<tr><td><b>${i.cantidad}</b></td><td>${esc(i.nombre)}${i.tipo === 'menu' ? ' <span class="etiqueta">MENÚ</span>' : ''}
                ${i.nota ? `<div class="nota">${esc(i.nota)}</div>` : ''}</td>
                <td class="num">${dinero(i.precio)}</td><td class="num">${dinero(i.precio * i.cantidad)}</td></tr>`
            )
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
  const [mesas, productos, existente] = await Promise.all([
    api('GET', '/api/mesas'),
    api('GET', '/api/productos?vigentes=1'),
    editando ? api('GET', `/api/comandas/${r.param}`) : null,
  ]);
  const b = {
    id: existente?.id || null,
    tipo: existente?.tipo || (S.me.rol === 'caja' ? 'llevar' : 'local'),
    mesa_id: existente?.mesa_id || Number(r.query.get('mesa')) || null,
    cliente: existente?.cliente || '',
    nota: existente?.nota || '',
    items: new Map(), // producto_id -> { cantidad, nota }
    estadoOriginal: existente?.estado || 'generado',
  };
  if (existente) for (const i of existente.items) if (i.producto_id) b.items.set(i.producto_id, { cantidad: i.cantidad, nota: i.nota });
  if (r.query.get('mesa')) b.tipo = 'local';
  S.borrador = b;
  // si la mesa de la comanda no está en la lista del mozo, la agregamos
  if (existente?.mesa_id && !mesas.find((m) => m.id === existente.mesa_id))
    mesas.push({ id: existente.mesa_id, numero: existente.mesa_numero, capacidad: '', ocupada: true });
  const porId = new Map(productos.map((p) => [p.id, p]));

  const total = () => [...b.items].reduce((s, [pid, it]) => s + (porId.get(pid)?.precio || 0) * it.cantidad, 0);
  const cantidadTotal = () => [...b.items.values()].reduce((s, it) => s + it.cantidad, 0);

  function filaProducto(p) {
    const it = b.items.get(p.id);
    const ok = b.tipo === 'local' ? p.para_local : p.para_llevar;
    if (!ok) return '';
    const sinStock = !p.disponible && !it;
    return `
      <div class="producto ${sinStock ? 'sin-stock' : ''}" data-pid="${p.id}" data-buscar="${esc((p.nombre + ' ' + p.categoria).toLowerCase())}">
        <div class="info">
          <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
          <div class="suave peq">${dinero(p.precio)}${p.descripcion ? ` · ${esc(p.descripcion)}` : ''}</div>
          <button type="button" class="btn-nota ${it ? '' : 'oculto'}" data-nota="${p.id}">${it?.nota ? `📝 ${esc(it.nota)}` : '＋ nota (sin ají, término…)'}</button>
        </div>
        <div class="contador-cant">
          <button type="button" data-menos="${p.id}" class="${it ? '' : 'oculto'}">−</button>
          <span class="v ${it ? '' : 'oculto'}">${it?.cantidad || 0}</span>
          <button type="button" class="mas" data-mas="${p.id}" ${sinStock ? 'disabled' : ''}>＋</button>
        </div>
      </div>`;
  }

  function seccion(titulo, lista) {
    const filas = lista.map(filaProducto).join('');
    if (!filas) return '';
    return `<div class="tarjeta"><h3>${titulo}</h3>${filas}</div>`;
  }

  function render() {
    const menu = productos.filter((p) => p.tipo === 'menu');
    const extras = productos.filter((p) => p.tipo === 'extra');
    const categorias = [...new Set(extras.map((p) => p.categoria || 'Otros'))];
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
                  mesas.length
                    ? `<div class="mesas-grid">${mesas
                        .map(
                          (m) => `<button type="button" class="mesa-btn ${m.ocupada ? 'ocupada' : ''} ${m.id === b.mesa_id ? 'sel' : ''}" data-mesa="${m.id}">
                            <span class="n">${esc(m.numero)}</span><span class="s">${m.ocupada ? 'ocupada' : 'libre'}</span></button>`
                        )
                        .join('')}</div>`
                    : '<div class="suave">No hay mesas registradas.</div>'
                }</div>`
            : `<div class="tarjeta"><label class="campo"><span>Nombre del cliente / referencia</span>
                <input id="cliente" value="${esc(b.cliente)}" placeholder="Ej: Juan, delivery 3…" autocomplete="off"></label></div>`
        }
        <input class="entrada" id="buscar" placeholder="🔎 Buscar plato…" autocomplete="off">
        ${seccion('📅 Menú del día', menu) || '<div class="tarjeta suave">No hay menú del día registrado para hoy.</div>'}
        ${categorias.map((cat) => seccion(`⭐ Extras · ${esc(cat)}`, extras.filter((p) => (p.categoria || 'Otros') === cat))).join('')}
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

  function refrescarFila(pid) {
    const fila = $(`.producto[data-pid="${pid}"]`, main);
    if (!fila) return;
    const it = b.items.get(pid);
    $('.v', fila).textContent = it?.cantidad || 0;
    $('.v', fila).classList.toggle('oculto', !it);
    $(`[data-menos]`, fila).classList.toggle('oculto', !it);
    const n = $('[data-nota]', fila);
    n.classList.toggle('oculto', !it);
    n.textContent = it?.nota ? `📝 ${it.nota}` : '＋ nota (sin ají, término…)';
    $('#total', main).textContent = dinero(total());
    $('#cant', main).textContent = `${cantidadTotal()} plato(s)`;
  }

  function enlazar() {
    $$('[data-tipo]', main).forEach(
      (el) =>
        (el.onclick = () => {
          b.tipo = el.dataset.tipo;
          // quitar platos que no aplican al nuevo tipo
          for (const pid of [...b.items.keys()]) {
            const p = porId.get(pid);
            if (p && !(b.tipo === 'local' ? p.para_local : p.para_llevar)) b.items.delete(pid);
          }
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
          const pid = Number(el.dataset.mas);
          const it = b.items.get(pid) || { cantidad: 0, nota: '' };
          it.cantidad = Math.min(99, it.cantidad + 1);
          b.items.set(pid, it);
          refrescarFila(pid);
        })
    );
    $$('[data-menos]', main).forEach(
      (el) =>
        (el.onclick = () => {
          const pid = Number(el.dataset.menos);
          const it = b.items.get(pid);
          if (!it) return;
          it.cantidad -= 1;
          if (it.cantidad <= 0) b.items.delete(pid);
          refrescarFila(pid);
        })
    );
    $$('[data-nota]', main).forEach(
      (el) =>
        (el.onclick = async () => {
          const pid = Number(el.dataset.nota);
          const it = b.items.get(pid);
          if (!it) return;
          const v = await pedirTexto(`Nota para: ${porId.get(pid)?.nombre}`, it.nota, 'Ej: sin cebolla, bien cocido');
          if (v !== null) {
            it.nota = v;
            refrescarFila(pid);
          }
        })
    );
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
    if (!b.items.size) return toast('Agregue al menos un plato', 'error');
    const cuerpo = {
      tipo: b.tipo,
      mesa_id: b.tipo === 'local' ? b.mesa_id : null,
      cliente: b.cliente,
      nota: b.nota,
      enviar,
      items: [...b.items].map(([producto_id, it]) => ({ producto_id, cantidad: it.cantidad, nota: it.nota })),
    };
    $$('.barra-total button', main).forEach((x) => (x.disabled = true));
    try {
      const c = b.id ? await api('PUT', `/api/comandas/${b.id}`, cuerpo) : await api('POST', '/api/comandas', cuerpo);
      toast(enviar ? `Comanda #${c.numero_dia} enviada a cocina` : `Comanda #${c.numero_dia} guardada`, 'ok');
      S.borrador = null;
      history.replaceState(null, '', '#/comandas');
      navegar();
    } catch (e) {
      toast(e.message, 'error', 4000);
      $$('.barra-total button', main).forEach((x) => (x.disabled = false));
    }
  }

  render();
}

// ---------- Cocina ----------
async function vCocina(main) {
  const lista = (await api('GET', '/api/comandas?vista=cocina')).sort((a, b) =>
    String(a.enviado_en || a.creado_en).localeCompare(String(b.enviado_en || b.creado_en))
  );
  const col = (estado, titulo) => {
    const cs = lista.filter((c) => c.estado === estado);
    return `<section class="cocina-col"><h3>${titulo} <span class="etiqueta">${cs.length}</span></h3>
      <div class="pila">${cs.map(ticket).join('') || '<div class="vacio peq">Sin comandas</div>'}</div></section>`;
  };
  const ticket = (c) => `
    <div class="tarjeta comanda ticket ${c.estado}" data-accion="ver-comanda" data-id="${c.id}">
      <div class="fila entre"><span class="num">#${c.numero_dia} · ${lugar(c)}</span>
        <span class="tiempo" data-desde="${esc(c.enviado_en || c.creado_en)}"></span></div>
      <div class="suave peq">${esc(c.mozo_nombre || '')} · enviado ${hora(c.enviado_en)}</div>
      <ul class="items">${c.items
        .map((i) => `<li><span class="cant">${i.cantidad}×</span>${esc(i.nombre)}${i.nota ? `<div class="nota">⚠️ ${esc(i.nota)}</div>` : ''}</li>`)
        .join('')}</ul>
      ${c.nota ? `<div class="nota">📝 ${esc(c.nota)}</div>` : ''}
      <div class="acciones">${botonesComanda(c, 'cocina')}</div>
    </div>`;
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>Cocina</h2><span class="suave peq">Se actualiza automáticamente</span></div>
      <div class="cocina-cols">
        ${col('enviado_cocina', '🔔 Nuevas')}
        ${col('en_proceso', '👨‍🍳 En proceso')}
        ${col('esperando_entrega', '✅ Listas para entregar')}
      </div>
    </div>`;
  const tick = () =>
    $$('[data-desde]', main).forEach((el) => {
      const m = minutosDesde(el.dataset.desde);
      el.textContent = `⏱ ${m} min`;
      el.classList.toggle('alerta', m >= 20);
    });
  tick();
  S.timers.forEach(clearInterval);
  S.timers = [setInterval(tick, 20000)];
}

// ---------- Mesas ----------
async function vMesas(main) {
  const rol = S.me.rol;
  const todas = rol !== 'mozo' || S.filtroMesas === 'todas';
  const [mesas, comandas] = await Promise.all([
    api('GET', `/api/mesas${todas ? '?todas=1' : ''}`),
    api('GET', '/api/comandas?vista=por_cobrar'),
  ]);
  const visibles = mesas.filter((m) => m.activa);
  const estadoMesa = (m) => (m.listas ? 'lista' : m.ocupada ? 'ocupada' : '');
  main.innerHTML = `
    <div class="pila">
      <div class="fila entre"><h2>${rol === 'mozo' && !todas ? 'Mis mesas' : 'Mesas'}</h2>
        <span class="suave peq">${visibles.filter((m) => m.ocupada).length}/${visibles.length} ocupadas</span></div>
      ${rol === 'mozo' ? chips([['mias', 'Mis mesas'], ['todas', 'Todas']], S.filtroMesas, 'fm') : ''}
      <div class="fila envolver peq suave">
        <span class="fila"><span class="leyenda"></span> Libre</span>
        <span class="fila"><span class="leyenda ocupada"></span> Ocupada (hasta cobrar)</span>
        <span class="fila"><span class="leyenda lista"></span> Plato listo</span>
      </div>
      ${
        visibles.length
          ? `<div class="mesas-grid">${visibles
              .map(
                (m) => `<button class="mesa-btn ${estadoMesa(m)}" data-m="${m.id}">
                  <span class="n">${esc(m.numero)}</span>
                  <span class="s">${m.listas ? '🍽️ listo' : m.ocupada ? `${m.comandas_abiertas} comanda(s)` : 'libre'}</span>
                  ${rol !== 'mozo' || todas ? `<span class="s">${esc(m.mozo_nombre || 'sin mozo')}</span>` : ''}
                </button>`
              )
              .join('')}</div>`
          : '<div class="vacio">No tiene mesas asignadas.</div>'
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
            ${cs.map(tarjetaComanda).join('')}
            <button class="btn primario bloque" data-accion="nueva-comanda" data-mesa="${m.id}">＋ Agregar otra comanda a esta mesa</button>
          </div>`);
        $('[data-x]', modal).onclick = cerrarModal;
      })
  );
}

// ---------- Carta (menú del día + extras) ----------
async function vCarta(main) {
  const productos = await api('GET', '/api/productos');
  const puedeAgotar = puede('admin', 'cocina');
  const fila = (p) => `
    <div class="producto">
      <div class="info">
        <div class="nombre">${esc(p.nombre)} ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''}</div>
        <div class="suave peq">${p.descripcion ? esc(p.descripcion) + ' · ' : ''}${p.para_local ? '🍽️ Mesa ' : ''}${p.para_llevar ? '🥡 Llevar' : ''}</div>
      </div>
      <div class="der"><b>${dinero(p.precio)}</b>
        ${puedeAgotar ? `<div><button class="btn chico ${p.disponible ? 'peligro' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotado' : 'Hay'}</button></div>` : ''}
      </div>
    </div>`;
  const menu = productos.filter((p) => p.tipo === 'menu');
  const extras = productos.filter((p) => p.tipo === 'extra');
  const cats = [...new Set(extras.map((p) => p.categoria || 'Otros'))];
  main.innerHTML = `
    <div class="pila">
      <h2>${S.me.rol === 'cocina' ? 'Platos disponibles' : 'Menú de hoy'}</h2>
      <div class="tarjeta"><h3>📅 Menú del día</h3>${menu.map(fila).join('') || '<div class="suave">Sin menú registrado hoy.</div>'}</div>
      ${cats.map((c) => `<div class="tarjeta"><h3>⭐ Extras · ${esc(c)}</h3>${extras.filter((p) => (p.categoria || 'Otros') === c).map(fila).join('')}</div>`).join('')}
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
        ${kpi(x.tiempo_promedio_cocina != null ? `${Math.round(x.tiempo_promedio_cocina)} min` : '-', 'Tiempo prom. cocina')}
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
    </div>`;
  $('#fecha', main).onchange = (e) => {
    S.fechaReporte = e.target.value || null;
    vReporte(main);
  };
}

// ---------- Gestión (admin) ----------
async function vAdmin(main) {
  const tabs = [['usuarios', '👤 Usuarios'], ['mesas', '🍽️ Mesas'], ['menu', '📅 Menú del día'], ['extras', '⭐ Extras']];
  main.innerHTML = `<div class="pila">${chips(tabs, S.adminTab, 'at')}<div id="admin-cont"></div></div>`;
  enlazarChips(main, 'at', (v) => {
    S.adminTab = v;
    vAdmin(main);
  });
  const cont = $('#admin-cont', main);
  await { usuarios: adminUsuarios, mesas: adminMesas, menu: adminProductos, extras: adminProductos }[S.adminTab](cont);
}

async function adminUsuarios(cont) {
  const us = await api('GET', '/api/usuarios');
  const campos = (nuevo) => [
    { n: 'nombre', l: 'Nombre completo', req: true },
    { n: 'usuario', l: 'Usuario (para ingresar)', req: true },
    { n: 'password', l: nuevo ? 'Contraseña' : 'Nueva contraseña (vacío = no cambiar)', t: 'password', req: nuevo },
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
  $('#nuevo', cont).onclick = () =>
    formulario({ titulo: 'Nuevo usuario', campos: campos(true), enviar: (d) => api('POST', '/api/usuarios', d) });
  $$('[data-edit]', cont).forEach(
    (b) =>
      (b.onclick = () => {
        const u = us.find((x) => x.id === Number(b.dataset.edit));
        formulario({
          titulo: `Editar: ${u.nombre}`,
          campos: campos(false),
          valores: { ...u, password: '' },
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

async function adminProductos(cont) {
  const esMenu = S.adminTab === 'menu';
  const fecha = S.fechaMenu || fechaHoy();
  const productos = await api('GET', esMenu ? `/api/productos?tipo=menu&fecha=${fecha}` : '/api/productos?tipo=extra');
  const campos = [
    { n: 'nombre', l: esMenu ? 'Nombre (ej: Sopa + Seco de res)' : 'Nombre del plato', req: true },
    { n: 'descripcion', l: 'Descripción (opcional)' },
    { n: 'categoria', l: 'Categoría (ej: Fondos, Bebidas, Postres)', def: esMenu ? 'Menú' : '' },
    { n: 'precio', l: `Precio (${S.config.moneda})`, t: 'number', paso: '0.10', req: true },
    ...(esMenu ? [{ n: 'fecha', l: 'Fecha del menú', t: 'date', def: fecha }] : []),
    { n: 'para_local', l: 'Disponible para mesa (local)', t: 'check', def: true },
    { n: 'para_llevar', l: 'Disponible para llevar', t: 'check', def: true },
    { n: 'disponible', l: 'Hay stock (desmarcar = agotado)', t: 'check', def: true },
    { n: 'activo', l: 'Activo (visible en la carta)', t: 'check', def: true },
  ];
  const tipo = esMenu ? 'menu' : 'extra';
  cont.innerHTML = `
    <div class="tarjeta">
      <div class="fila entre envolver">
        <h3>${esMenu ? 'Menú del día' : 'Extras (carta fija)'} (${productos.length})</h3>
        <button class="btn chico primario" id="nuevo">＋ Agregar</button>
      </div>
      ${
        esMenu
          ? `<div class="fila envolver" style="margin-top:10px">
              <input type="date" class="entrada" id="fecha" value="${fecha}" style="width:auto">
              <button class="btn chico" id="copiar">📋 Copiar de otro día</button></div>`
          : ''
      }
      <div class="lista-admin">${
        productos
          .map(
            (p) => `<div class="item">
              <div class="crecer"><b>${esc(p.nombre)}</b>
                ${!p.disponible ? '<span class="etiqueta agotado">AGOTADO</span>' : ''} ${!p.activo ? '<span class="etiqueta">INACTIVO</span>' : ''}
                <div class="suave peq">${dinero(p.precio)}${p.categoria ? ` · ${esc(p.categoria)}` : ''} · ${p.para_local ? '🍽️ Mesa ' : ''}${p.para_llevar ? '🥡 Llevar' : ''}</div></div>
              <button class="btn chico ${p.disponible ? '' : 'ok'}" data-accion="disponible" data-id="${p.id}" data-v="${p.disponible ? 0 : 1}">${p.disponible ? 'Agotar' : 'Hay'}</button>
              <button class="btn chico" data-edit="${p.id}">✏️</button></div>`
          )
          .join('') || `<div class="vacio">${esMenu ? 'No hay menú para esta fecha. Agréguelo o cópielo de otro día.' : 'Sin extras registrados.'}</div>`
      }</div>
    </div>`;
  $('#nuevo', cont).onclick = () =>
    formulario({ titulo: esMenu ? 'Agregar al menú del día' : 'Nuevo extra', campos, enviar: (d) => api('POST', '/api/productos', { ...d, tipo }) });
  $$('[data-edit]', cont).forEach(
    (b) =>
      (b.onclick = () => {
        const p = productos.find((x) => x.id === Number(b.dataset.edit));
        formulario({
          titulo: 'Editar plato',
          campos,
          valores: p,
          enviar: (d) => api('PUT', `/api/productos/${p.id}`, { ...d, tipo }),
          eliminar: async () => {
            const r = await api('DELETE', `/api/productos/${p.id}`);
            cerrarModal();
            toast(r.desactivado ? 'El plato tiene ventas: se desactivó' : 'Plato eliminado', 'ok');
          },
        });
      })
  );
  if (esMenu) {
    $('#fecha', cont).onchange = (e) => {
      S.fechaMenu = e.target.value || null;
      adminProductos(cont);
    };
    $('#copiar', cont).onclick = () => {
      const ayer = new Date(parseFecha(fecha + ' 12:00:00').getTime() - 86400000);
      const z = (n) => String(n).padStart(2, '0');
      formulario({
        titulo: `Copiar menú hacia el ${fecha}`,
        campos: [{ n: 'desde', l: 'Copiar desde la fecha', t: 'date', req: true }],
        valores: { desde: `${ayer.getFullYear()}-${z(ayer.getMonth() + 1)}-${z(ayer.getDate())}` },
        enviar: async (d) => {
          const r = await api('POST', '/api/productos/copiar-menu', { desde: d.desde, hasta: fecha });
          toast(`${r.copiados} plato(s) copiados`, 'ok');
        },
      });
    };
  }
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
