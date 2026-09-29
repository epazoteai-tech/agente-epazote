/**
 * Prueba de `stripReasoning` (services/claude.ts) — el filtro que evita que el
 * razonamiento interno del modelo le llegue al paciente por WhatsApp.
 *
 * Igual que las demás pruebas del proyecto: sin framework, contra dist/.
 *
 *   npm run build && npm run test:razonamiento
 *
 * El caso 1 es textual: es el mensaje que recibió una paciente real el
 * 14/09/2026 a las 22:05. Los casos "NO tocar" son la otra mitad del trabajo:
 * un filtro que se come mensajes buenos es peor que el bug que arregla.
 */
process.env.GHL_API_KEY = 'x';
process.env.ANTHROPIC_API_KEY = 'x';
process.env.GHL_LOCATION_ID = 'loc';
process.env.DATABASE_URL = 'postgres://x/x';

const path = require('path');
const { stripReasoning } = require(path.join(__dirname, '..', 'dist', 'services', 'claude.js'));

let fallos = 0;

function caso(nombre, entrada, esperado) {
  const { text } = stripReasoning(entrada);
  const ok = text === esperado;
  if (!ok) fallos++;
  console.log(`${ok ? '✅' : '❌'} ${nombre}`);
  if (!ok) {
    console.log(`   esperado: ${JSON.stringify(esperado)}`);
    console.log(`   obtenido: ${JSON.stringify(text)}`);
  }
}

// ── Lo que SÍ debe quitar ───────────────────────────────────────────────────

caso(
  'fuga real del 14/09/2026 (Josefina)',
  'El slot de las 10:00am del martes 22 no aparece disponible. Tengo que avisarle a Josefina antes de confirmarle ese horario.\n\n' +
    'Josefina, disculpe, el horario de las 10:00am del martes 22 ya no está disponible. Tengo las 9:00am o las 11:00am ese mismo día, cuál le queda mejor?',
  'Josefina, disculpe, el horario de las 10:00am del martes 22 ya no está disponible. Tengo las 9:00am o las 11:00am ese mismo día, cuál le queda mejor?'
);

caso(
  'narración y respuesta con un solo salto de línea',
  'Voy a llamar agendar_cita con el slot confirmado.\nListo! Quedaste el *martes 22 a las 9:00am* ✅',
  'Listo! Quedaste el *martes 22 a las 9:00am* ✅'
);

caso(
  'menciona el nombre de una tool',
  'Primero corro consultar_disponibilidad.\n\nHola! Con gusto te busco un horario 😊',
  'Hola! Con gusto te busco un horario 😊'
);

caso(
  'habla del paciente en tercera persona',
  'El paciente ya confirmó que asistirá, así que procedo.\n\nListo, te esperamos el jueves ✅',
  'Listo, te esperamos el jueves ✅'
);

caso(
  'anuncia que va a revisar',
  'Déjame verificar la agenda.\n\nTengo el jueves a las 4:00pm o el viernes a las 10:00am, cuál te acomoda?',
  'Tengo el jueves a las 4:00pm o el viernes a las 10:00am, cuál te acomoda?'
);

caso(
  'respuesta 100% narración se descarta completa',
  'Tengo que preguntarle a Marisol si prefiere mañana o tarde antes de seguir.',
  ''
);

// ── Lo que NO debe tocar ────────────────────────────────────────────────────

caso(
  'NO tocar: confirmación normal con usted',
  'Listo! Quedaste el *martes 22 a las 9:00am* ✅ Te esperamos, que tenga buenas noches 😊',
  'Listo! Quedaste el *martes 22 a las 9:00am* ✅ Te esperamos, que tenga buenas noches 😊'
);

caso(
  'NO tocar: trato de usted con pronombre -le',
  'Josefina, con gusto le confirmo su cita. Puedo ofrecerle las 9:00am o las 11:00am, cuál le queda mejor?',
  'Josefina, con gusto le confirmo su cita. Puedo ofrecerle las 9:00am o las 11:00am, cuál le queda mejor?'
);

caso(
  'NO tocar: bloque del anticipo en varias líneas',
  'Para asegurar tu espacio manejamos una reserva de $500.\n\nBanco: Banorte\nTarjeta: 4189 2810 1104 2521\nCLABE: 072078012869432838\nNombre: Miguel Ángel Sánchez Cota\n\nEn cuanto me mandes el comprobante te confirmo tu lugar ✨',
  'Para asegurar tu espacio manejamos una reserva de $500.\n\nBanco: Banorte\nTarjeta: 4189 2810 1104 2521\nCLABE: 072078012869432838\nNombre: Miguel Ángel Sánchez Cota\n\nEn cuanto me mandes el comprobante te confirmo tu lugar ✨'
);

caso(
  'NO tocar: lista de lo que incluye la valoración',
  'La valoración incluye:\n• Diagnóstico completo\n• Radiografías y fotografías\n• Tu plan de tratamiento por escrito\n\nTe agendo?',
  'La valoración incluye:\n• Diagnóstico completo\n• Radiografías y fotografías\n• Tu plan de tratamiento por escrito\n\nTe agendo?'
);

caso(
  'NO tocar: escalación ya hecha',
  'Ya le avisé al equipo del Dr. Miguel para que te contacten directamente 😊 En un momento se comunican contigo.',
  'Ya le avisé al equipo del Dr. Miguel para que te contacten directamente 😊 En un momento se comunican contigo.'
);

console.log(fallos === 0 ? '\nTodo bien.' : `\n${fallos} caso(s) fallando.`);
process.exit(fallos === 0 ? 0 : 1);
