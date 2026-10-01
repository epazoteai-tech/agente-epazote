/**
 * Mesa de Control: las decisiones puras (sin red ni base).
 *
 *   npm run test:mesa
 *
 * Lo que más cuesta si sale mal: atribuir una reserva a la campaña equivocada
 * (el ROAS por creativo es la métrica que se le vende al cliente) y un show
 * rate que cuente como no-show lo que todavía no pasa.
 */
const { campanaDeOrigen, embudo, gastoDelPeriodo, esCambio, ocasionLimpia } = require('../dist/services/mesa');

let fallas = 0;
function check(nombre, real, esperado) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${nombre}${ok ? '' : ` → ${JSON.stringify(real)} (esperado ${JSON.stringify(esperado)})`}`);
}

const C = (id, nombre, palabra_clave) => ({ id, nombre, palabra_clave, gasto_mensual: 3000, activa: true });
const camps = [C(1, 'Reel cabrito', 'cabrito'), C(2, 'Reel cabrito mole', 'cabrito con mole'), C(3, 'Machacado', 'machacado')];

check('atribuye por palabra clave', campanaDeOrigen('Hola, vengo del video del machacado', camps)?.nombre, 'Machacado');
check('sin acentos ni mayúsculas', campanaDeOrigen('VENGO DEL MACHACÁDO', camps)?.nombre, 'Machacado');
check('gana la palabra clave más específica', campanaDeOrigen('quiero el cabrito con mole blanco', camps)?.nombre, 'Reel cabrito mole');
check('la corta sigue funcionando sola', campanaDeOrigen('vi lo del cabrito', camps)?.nombre, 'Reel cabrito');
check('sin coincidencia es directo', campanaDeOrigen('hola, info', camps), null);
check('origen vacío es directo', campanaDeOrigen('', camps), null);
check('palabra clave vacía no atrapa todo', campanaDeOrigen('hola', [C(9, 'Rota', '  ')]), null);

const F = (estado, canal = 'bot', total = null) => ({ estado, canal, total });
const e = embudo([
  F('solicitada'), F('confirmada'), F('llego', 'bot', 1200), F('llego'), F('no_llego'), F('cancelada'),
  F('llego', 'walk-in', 500), F('llego', 'telefono', 800),
]);
check('solicitudes no incluyen walk-ins', e.solicitudes, 7);
check('confirmadas incluye las que ya llegaron o no (1 + 3 + 1)', e.confirmadas, 5);
check('llegaron', e.llegaron, 3);
check('show rate solo con lo ya decidido (3 de 4)', e.showRate, 0.75);
check('una confirmada para mañana no cuenta como no-show', embudo([F('confirmada'), F('llego')]).showRate, 1);
check('sin nada decidido, show rate vacío (no 0%)', embudo([F('solicitada')]).showRate, null);
check('walk-ins aparte', e.walkins, 1);
check('con consumo registrado', e.conConsumo, 2);

check('gasto prorrateado a 7 días', gastoDelPeriodo(3000, 7), 700);
check('gasto de un mes', gastoDelPeriodo(3000, 30), 3000);

check('detecta cambio', esCambio('CAMBIO de la solicitud anterior. Ahora son 4'), true);
check('no confunde una ocasión normal', esCambio('cumpleaños, cambio de planes'), false);
check('quita la marca de cambio', ocasionLimpia('CAMBIO de la solicitud anterior: cumpleaños'), 'cumpleaños');

console.log(fallas ? `\n${fallas} FALLA(S)` : '\nTodo bien');
process.exit(fallas ? 1 : 0);
