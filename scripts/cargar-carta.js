// Carga o actualiza la carta (guarniciones y platos) en la base de datos local, sin borrar nada.
//
// Uso:
//   npm run cargar-carta                       -> usa carta/platos-tradicionales.json
//   npm run cargar-carta -- otra-carta.json    -> usa otro archivo
//   npm run cargar-carta -- --desactivar-otros -> además oculta los platos que no están en el archivo
//
// Puede ejecutarse con el servidor encendido; los celulares verán los cambios al recargar la página.
const path = require('node:path');
const { leerCarta, cargarCarta, CARTA_POR_DEFECTO } = require('../server/carta-inicial');

const args = process.argv.slice(2);
const desactivarOtros = args.includes('--desactivar-otros');
const archivo = args.find((a) => !a.startsWith('--')) || CARTA_POR_DEFECTO;

try {
  const datos = leerCarta(path.resolve(archivo));
  const r = cargarCarta(datos, { desactivarOtros });
  console.log(`Carta cargada desde ${archivo}`);
  console.log(`  Guarniciones: ${r.guarnicionesCreadas} nuevas, ${r.guarnicionesActualizadas} actualizadas`);
  console.log(`  Platos:       ${r.platosCreados} nuevos, ${r.platosActualizados} actualizados`);
  if (r.platosDesactivados.length) console.log(`  Ocultados (no están en el archivo): ${r.platosDesactivados.join(', ')}`);
  for (const p of datos.pendientes || []) console.log(`  Pendiente: ${p}`);
} catch (e) {
  console.error('No se pudo cargar la carta:', e.message);
  process.exit(1);
}
