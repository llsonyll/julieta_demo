// Carga (o actualiza) guarniciones y platos desde un archivo JSON, sin borrar nada.
// Se busca cada guarnición y plato por su nombre: si existe se actualiza, si no se crea.
const fs = require('node:fs');
const path = require('node:path');
const { db, tx } = require('./db');

const CARTA_POR_DEFECTO = path.join(__dirname, '..', 'carta', 'platos-tradicionales.json');

function leerCarta(archivo = CARTA_POR_DEFECTO) {
  return JSON.parse(fs.readFileSync(archivo, 'utf8'));
}

function cargarCarta(datos, { desactivarOtros = false } = {}) {
  const r = { guarnicionesCreadas: 0, guarnicionesActualizadas: 0, platosCreados: 0, platosActualizados: 0, platosDesactivados: [] };
  tx(() => {
    const buscarG = db.prepare('SELECT id FROM guarniciones WHERE nombre = ? COLLATE NOCASE');
    for (const g of datos.guarniciones || []) {
      const nombre = String(g.nombre).trim();
      const existe = buscarG.get(nombre);
      if (existe) {
        db.prepare('UPDATE guarniciones SET nombre = ?, activo = 1, eleccion_habitual = ? WHERE id = ?').run(nombre, g.eleccion_habitual ? 1 : 0, existe.id);
        r.guarnicionesActualizadas++;
      } else {
        db.prepare('INSERT INTO guarniciones (nombre, activo, eleccion_habitual) VALUES (?, 1, ?)').run(nombre, g.eleccion_habitual ? 1 : 0);
        r.guarnicionesCreadas++;
      }
    }

    const buscarP = db.prepare('SELECT id FROM productos WHERE nombre = ? COLLATE NOCASE');
    const nombres = [];
    for (const p of datos.platos || []) {
      const nombre = String(p.nombre).trim();
      nombres.push(nombre.toLowerCase());
      let baseId = null;
      if (p.guarnicion_base) {
        baseId = buscarG.get(p.guarnicion_base)?.id;
        if (!baseId) throw new Error(`La guarnición "${p.guarnicion_base}" de "${nombre}" no está en la lista de guarniciones`);
      }
      const valores = [
        nombre,
        p.descripcion || '',
        p.categoria || 'Otros',
        Number(p.precio),
        p.tipo === 'menu' ? 'menu' : 'extra',
        baseId,
        p.con_eleccion ? 1 : 0,
        // ponytail: sin precio (null) = se guarda inactivo para que no se venda a S/ 0
        p.precio === null ? 0 : 1,
      ];
      if (!Number.isFinite(valores[3]) || valores[3] < 0) throw new Error(`Precio inválido en "${nombre}"`);
      const existe = buscarP.get(nombre);
      if (existe) {
        db.prepare(
          `UPDATE productos SET nombre=?, descripcion=?, categoria=?, precio=?, tipo=?, guarnicion_base_id=?, con_eleccion=?,
             activo=? WHERE id=?`
        ).run(...valores, existe.id);
        r.platosActualizados++;
      } else {
        db.prepare(
          `INSERT INTO productos (nombre, descripcion, categoria, precio, tipo, guarnicion_base_id, con_eleccion, activo)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(...valores);
        r.platosCreados++;
      }
    }

    if (desactivarOtros) {
      const otros = db.prepare('SELECT id, nombre FROM productos WHERE activo = 1').all().filter((p) => !nombres.includes(p.nombre.toLowerCase()));
      const des = db.prepare('UPDATE productos SET activo = 0 WHERE id = ?');
      for (const p of otros) {
        des.run(p.id);
        r.platosDesactivados.push(p.nombre);
      }
    }
  });
  return r;
}

module.exports = { leerCarta, cargarCarta, CARTA_POR_DEFECTO };
