/**
 * ¿El bot puede crear una cita DE VERDAD, de cada duración del catálogo?
 *
 * Esta es la prueba que faltaba y que costó más caro no tener. Del 8 al 17 de
 * septiembre el bot no creó una sola cita: GHL rechazaba con 400 toda cita que
 * no durara exactamente los 30 minutos de la casilla del calendario. Desde
 * afuera el síntoma era una frase normal —"ese horario ya se ocupó"— así que
 * nadie lo notó hasta que una paciente recorrió seis horarios ya con el
 * anticipo pagado.
 *
 * Lo que hace, por cada duración distinta del yaml:
 *   1. Busca un hueco real donde quepa (mismos filtros que usa el bot).
 *   2. Crea la cita CONTRA LA AGENDA REAL.
 *   3. La vuelve a leer de GHL y comprueba que quedó con su duración exacta.
 *   4. La cancela.
 *
 * Sí toca producción: crea y cancela citas reales. Por eso busca los huecos
 * más lejanos que encuentra y las titula "PRUEBA TECNICA - borrar". Si algo
 * truena a media prueba, al final imprime lo que haya quedado vivo para que lo
 * borres a mano.
 *
 *   npm run test:agendar [contactId]
 */

const { getConfig } = require('../dist/config');
const {
  getFreeSlots,
  createAppointment,
  cancelarCita,
  getContactAppointments,
  getCalendarAssignedUser,
} = require('../dist/services/ghl-calendar');
const {
  dentroDeHorario,
  granularidadDeSlots,
  bloqueLibre,
} = require('../dist/services/horario');

const TITULO = 'PRUEBA TECNICA - borrar';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * El contacto contra el que se prueba. SIEMPRE explícito, nunca deducido.
 *
 * Antes esta prueba tomaba "el primer contacto que haya conversado con el
 * bot", que en una cuenta viva es un cliente real. Cada cita de prueba deja
 * una entrada "PRUEBA TECNICA - borrar" en SU historial de GHL: no le llega
 * por WhatsApp, pero le ensucia la conversación y cualquiera que la abra ve
 * ruido nuestro encima de sus mensajes. Pasó, y no se repite.
 *
 * Crea un contacto dedicado en GHL (ej. "ZZ Pruebas Técnicas", con un número
 * que no sea de nadie), y pásalo por env o por argumento.
 */
function contactoDePrueba() {
  const dado = process.argv[2] || process.env.TEST_CONTACT_ID;
  if (dado) return dado;
  throw new Error(
    'Falta el contacto de prueba. NO se deduce solo a propósito: probar contra un cliente\n' +
      'real le deja basura en su historial de GHL.\n\n' +
      '  1. En GHL crea un contacto dedicado (ej. "ZZ Pruebas Técnicas").\n' +
      '  2. Corre:  npm run test:agendar <contactId>\n' +
      '     o deja  TEST_CONTACT_ID=<contactId>  en tu .env'
  );
}

/** Un hueco real donde quepa una cita de `duracion`, lo más lejos posible. */
async function huecoPara(duracion, cal, ag, ocupados) {
  const DIA = 24 * 60 * 60 * 1000;
  for (let semana = 4; semana < 10; semana++) {
    const desde = Date.now() + semana * 7 * DIA;
    const slots = await getFreeSlots(ag.calendar_id, desde, desde + 7 * DIA, cal.timezone);
    await sleep(1200);
    if (slots.length === 0) continue;

    const libres = new Set(slots.map((s) => new Date(s.iso).getTime()).filter((t) => !isNaN(t)));
    const gran = granularidadDeSlots(slots.map((s) => s.iso));
    const sirve = slots.find(
      (s) =>
        !ocupados.has(s.iso) &&
        dentroDeHorario(s.iso, cal, duracion) &&
        bloqueLibre(s.iso, duracion, libres, gran)
    );
    if (sirve) return sirve.iso;
  }
  return null;
}

(async () => {
  const cfg = getConfig();
  const cal = cfg.calendars;
  if (!cal) throw new Error('Este bot no tiene bloque calendars: en el yaml.');

  const agendaKey = Object.keys(cal.agendas)[0];
  const ag = cal.agendas[agendaKey];
  const contactId = contactoDePrueba();
  const locationId = process.env.GHL_LOCATION_ID;

  // Una prueba por duración DISTINTA, no por tipo de cita: lo que GHL valida
  // son los minutos, así que con 30/45/60 se cubren los siete motivos.
  const duraciones = [...new Set(Object.values(cal.durations || { d: cal.duration_minutes }))].sort(
    (a, b) => a - b
  );
  const nombrePorDuracion = (d) =>
    Object.entries(cal.durations || {})
      .filter(([, v]) => v === d)
      .map(([k]) => k)
      .join(' / ') || 'default';

  console.log(`Agenda: ${ag.name}`);
  console.log(`Duraciones a probar: ${duraciones.join(', ')} min\n`);

  // Mismo camino que usa el bot: yaml primero, y si no, el team member del
  // calendario. Si no hay ninguno, GHL responde 422 y la prueba lo dice.
  const assignedUserId =
    ag.assigned_user_id ?? (await getCalendarAssignedUser(ag.calendar_id)) ?? undefined;
  if (!assignedUserId) {
    console.log('⚠️  El calendario no tiene team member asignado. Sin eso GHL rechaza las citas.');
  }

  const ocupados = new Set();
  const creadas = [];
  let fallos = 0;

  for (const duracion of duraciones) {
    const etiqueta = `${duracion} min (${nombrePorDuracion(duracion)})`;
    const iso = await huecoPara(duracion, cal, ag, ocupados);
    if (!iso) {
      console.log(`⚠️  ${etiqueta}: no encontré un hueco libre para probar. Repite otro día.`);
      continue;
    }
    ocupados.add(iso);

    const start = new Date(iso);
    const end = new Date(start.getTime() + duracion * 60 * 1000);
    let creada = null;
    try {
      creada = await createAppointment({
        calendarId: ag.calendar_id,
        locationId,
        contactId,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        title: TITULO,
        assignedUserId,
      });
      creadas.push(creada.id);
      await sleep(1500);

      const real = (await getContactAppointments(contactId)).find((x) => x.id === creada.id);
      const minutos = real
        ? (new Date(real.endTime).getTime() - new Date(real.startTime).getTime()) / 60000
        : null;

      if (minutos === duracion) {
        console.log(`✅ ${etiqueta}: creada y GHL la guardó de ${minutos} min`);
      } else {
        fallos++;
        console.log(
          `❌ ${etiqueta}: se creó pero GHL la guardó de ${minutos} min (pedimos ${duracion})`
        );
      }
    } catch (err) {
      fallos++;
      const msg = String(err.message || err);
      console.log(`❌ ${etiqueta}: ${msg.slice(0, 160)}`);
      if (msg.includes('not a valid duration option')) {
        console.log(
          '    ↳ Es E121: falta `ignoreFreeSlotValidation: true` al crear la cita ' +
            '(y `assignedUserId`, que GHL exige en ese modo).'
        );
      }
    } finally {
      if (creada?.id) {
        try {
          await cancelarCita(creada.id);
          creadas.pop();
        } catch (e) {
          console.log(`    ⚠️ NO SE PUDO CANCELAR ${creada.id} — bórrala a mano en GHL`);
        }
      }
      await sleep(1200);
    }
  }

  // Red de seguridad: nada de prueba se queda vivo en la agenda de un cliente.
  const vivas = (await getContactAppointments(contactId)).filter(
    (x) =>
      x.title === TITULO && !(x.appointmentStatus || '').toLowerCase().includes('cancel')
  );
  if (vivas.length > 0) {
    console.log(`\n⚠️  QUEDARON ${vivas.length} cita(s) de prueba SIN CANCELAR:`);
    vivas.forEach((x) => console.log(`    ${x.id}  ${x.startTime}`));
  }

  console.log(fallos === 0 ? '\nTodo bien: el bot sí puede agendar.' : `\n${fallos} duración(es) fallaron.`);
  process.exit(fallos === 0 && vivas.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
