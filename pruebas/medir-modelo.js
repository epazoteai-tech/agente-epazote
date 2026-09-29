/**
 * Compara modelos de Claude sobre el prompt y las tools REALES de este bot,
 * y califica cada respuesta contra las reglas de `rules.do_not`.
 *
 * Existe porque elegir modelo por la tabla de precios por token no funciona:
 * el tokenizador cambia entre generaciones, el thinking consume presupuesto de
 * salida, y un modelo que resuelve en menos vueltas reenvía el prompt menos
 * veces. El costo real solo se sabe midiendo. Ver lecciones 25 y 26.
 *
 *   npm run build && npm run test:modelo claude-sonnet-4-6 claude-haiku-4-5
 *
 * Los `tool_use` se responden con resultados sintéticos: NO toca GHL, no
 * agenda nada, no mueve contactos. Sí gasta crédito real de Anthropic (unos
 * $0.50-1.50 USD por modelo con 25 conversaciones); lo imprime antes de correr.
 *
 * Las conversaciones viven en `pruebas/conversaciones.js` (cópialas de
 * `conversaciones.ejemplo.js` y escríbelas con los casos REALES del cliente).
 */
const path = require('path');
const fs = require('fs');

const RAIZ = path.join(__dirname, '..');
require(path.join(RAIZ, 'node_modules/dotenv')).config({ path: path.join(RAIZ, '.env') });
const Anthropic = require(path.join(RAIZ, 'node_modules/@anthropic-ai/sdk')).default;

const D = (p) => path.join(RAIZ, 'dist', p);
const { TOOLS } = require(D('services/claude.js'));
const { buildSystemPrompt } = require(D('prompts/system.js'));
const { getConfig } = require(D('config.js'));
const { validarReserva } = require(D('services/reservas.js'));

// $/1M tokens: [input, output, escritura de caché (1.25x), lectura de caché (0.1x)]
const PRECIOS = {
  'claude-opus-5':     [5.0, 25.0, 6.25, 0.50],
  'claude-sonnet-5':   [2.0, 10.0, 2.50, 0.20],
  'claude-sonnet-4-6': [3.0, 15.0, 3.75, 0.30],
  'claude-haiku-4-5':  [1.0,  5.0, 1.25, 0.10],
};

// ---------------------------------------------------------------------------
// Batería de reglas. Cada una sale de una línea real de rules.do_not (o de
// <regla_de_avance>). Las que dependen del cliente se activan solas leyendo
// la config, para que la plantilla sirva igual con tuteo que con "usted".
// ---------------------------------------------------------------------------
const TUTEO = /\b(tú|ti|contigo|tuyo|tuya|tienes|puedes|quieres|necesitas|debes|sabes|estás|eres|vienes|dime|cuéntame|cuentame|mándame|mandame|escríbeme|escribeme|avísame|avisame)\b|\b(ayudar|contactar|atender|mandar|enviar|explicar|comentar|pasar|conectar|apoyar)te\b/i;

function bateria(cfg) {
  const doNot = (cfg.rules && cfg.rules.do_not) || [];
  const pide = (frag) => doNot.some((r) => r.toLowerCase().includes(frag));
  const reglas = [
    ['vacío',           (t) => t.trim() === ''],
    ['signo apertura',  (t) => /[¿¡]/.test(t)],
    ['guion largo',     (t) => /—/.test(t)],
    ['viñetas',         (t) => /(^|\n)\s*[•*]|\n\s*-\s+\S/.test(t)],
    ['negritas **',     (t) => /\*\*[^*]+\*\*/.test(t)],
    ['frase de IA',     (t) => /con mucho gusto te informo|es un placer atenderte|estoy aquí para ayudarte/i.test(t)],
    ['anuncia revisar', (t) => /(déjame|dejame|permíteme|permiteme)\s+(verificar|revisar|checar|un momento)|ahorita (reviso|checo|verifico)|voy a revisar/i.test(t)],
    ['cierre pasivo',   (t) => /\b(cualquier duda (estoy|aquí)|espero (su|tu) respuesta|quedo al pendiente|estamos al pendiente|no dude[s]? en escribir)/i.test(t)],
    ['supone género',   (t) => /\bbienvenid[oa]\b/i.test(t)],
  ];
  // "Tutear a un contacto, siempre usted" → solo aplica si el cliente lo pidió.
  if (pide('tutear')) reglas.push(['tuteo', (t) => TUTEO.test(t)]);
  return reglas;
}

function bloquesSystem() {
  // Mismo armado que services/claude.ts: estático cacheado primero.
  return [
    { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '\n\n---\n## CONTEXTO DEL TURNO\n- Canal de entrada: whatsapp\n- Estado del teléfono del contacto: tiene WhatsApp\n' },
    // Sin la fecha de hoy el modelo no puede convertir "mañana" en YYYY-MM-DD
    // para registrar_reserva (en producción lo pone getDateContext).
    ...(getConfig().reservations ? [{ type: 'text', text: contextoTemporal() }] : []),
  ];
}

function contextoTemporal() {
  const tz = getConfig().reservations.timezone;
  const now = new Date();
  const human = new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const hora = new Intl.DateTimeFormat('es', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
  return `<contexto_temporal>\nHoy es ${human} (${iso}), son las ${hora}. Timezone del negocio: ${tz}.\n</contexto_temporal>`;
}

function resultadoSintetico(nombre, input) {
  switch (nombre) {
    case 'mover_a_etapa':    return `Contacto movido a la etapa "${input.etapa}".`;
    case 'escalar_a_humano': return 'Escalado a una persona del equipo. Tag y nota aplicados.';
    case 'actualizar_campo': return `Campo "${input.campo}" guardado.`;
    case 'consultar_horarios': return 'Horarios disponibles: mañana 10:00, mañana 12:30, pasado mañana 16:00.';
    case 'agendar_cita':     return 'Cita creada para el horario solicitado.';
    case 'cancelar_cita':    return 'Cita cancelada.';
    case 'registrar_reserva': {
      // Validación REAL (horario, grupo grande, fecha pasada): los errores son
      // justo los turnos que hay que medir.
      const v = validarReserva(
        { nombre: input.nombre, fecha: input.fecha, hora: input.hora, personas: Number(input.personas), ocasion: input.ocasion },
        getConfig().reservations
      );
      return JSON.stringify(v.ok
        ? { ok: true, resumen: v.resumen, aviso_importante: 'La solicitud quedó REGISTRADA, NO confirmada. Cierra con el guion de registro, nunca digas que está confirmada.' }
        : { error: v.error, message: v.message });
    }
    case 'cerrar_seguimiento': return JSON.stringify({ ok: true });
    default:                 return 'OK';
  }
}

async function unTurno(client, model, variante, messages, cfg, acum) {
  // Espejo de getClaudeResponse (services/claude.ts), incluida la acumulación
  // de finalText entre iteraciones: si no, se pierde el texto que el modelo
  // manda JUNTO con un tool_use y parecen respuestas vacías que no lo son.
  let finalText = '', iter = 0, tools = [], stop = 'unknown';
  while (iter < 10) {
    iter++;
    const body = {
      model, max_tokens: cfg.behavior.max_response_tokens,
      system: bloquesSystem(), tools: TOOLS, messages,
    };
    if (variante === 'nothink') body.thinking = { type: 'disabled' };
    const r = await client.messages.create(body);

    const u = r.usage;
    acum.llamadas++; acum.in += u.input_tokens; acum.out += u.output_tokens;
    acum.cw += u.cache_creation_input_tokens || 0; acum.cr += u.cache_read_input_tokens || 0;
    if (r.content.some((b) => b.type === 'thinking')) acum.conThinking++;
    stop = r.stop_reason;
    if (stop === 'max_tokens') acum.truncados++;

    const texto = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (texto) finalText = texto;

    messages.push({ role: 'assistant', content: r.content });
    if (stop === 'tool_use') {
      const usos = r.content.filter((b) => b.type === 'tool_use');
      usos.forEach((t) => { acum.toolCalls++; tools.push(t.name); });
      messages.push({ role: 'user', content: usos.map((t) => ({
        type: 'tool_result', tool_use_id: t.id, content: resultadoSintetico(t.name, t.input),
      })) });
      continue;
    }
    break;
  }
  return { finalText, tools, stop };
}

async function correr(client, spec, convs, cfg) {
  const [model, variante] = spec.split(':');
  const acum = { llamadas: 0, in: 0, out: 0, cw: 0, cr: 0, toolCalls: 0, truncados: 0, conThinking: 0, turnos: 0 };
  const transcripciones = {};
  const t0 = Date.now();
  for (const [nombre, turnos] of convs) {
    const messages = [];
    transcripciones[nombre] = [];
    for (const turno of turnos) {
      messages.push({ role: 'user', content: turno });
      const r = await unTurno(client, model, variante, messages, cfg, acum);
      acum.turnos++;
      transcripciones[nombre].push({ contacto: turno, bot: r.finalText, tools: r.tools, stop: r.stop });
    }
    process.stderr.write('.');
  }
  const [pi, po, pw, pr] = PRECIOS[model] || [0, 0, 0, 0];
  const costo = (acum.in * pi + acum.out * po + acum.cw * pw + acum.cr * pr) / 1e6;
  process.stderr.write('\n');
  return { spec, ...acum, costo, segundos: Math.round((Date.now() - t0) / 1000), transcripciones };
}

function reportar(corridas, reglas) {
  const ancho = Math.max(20, ...reglas.map(([n]) => n.length + 2));
  const col = (s) => String(s).padStart(18);
  const datos = corridas.map((c) => {
    const cuenta = {};
    for (const filas of Object.values(c.transcripciones))
      for (const f of filas)
        for (const [n, fn] of reglas) if (fn(f.bot)) cuenta[n] = (cuenta[n] || 0) + 1;
    return { c, cuenta, total: Object.values(cuenta).reduce((a, b) => a + b, 0) };
  });

  console.log('\n' + 'VIOLACIONES DE rules.do_not'.padEnd(ancho) + corridas.map((c) => col(c.spec.replace('claude-', ''))).join(''));
  for (const [n] of reglas) {
    if (!datos.some((d) => d.cuenta[n])) continue;
    console.log(n.padEnd(ancho) + datos.map((d) => col(d.cuenta[n] || 0)).join(''));
  }
  console.log('-'.repeat(ancho + 18 * corridas.length));
  console.log('TOTAL'.padEnd(ancho) + datos.map((d) => col(d.total)).join(''));
  console.log('');
  console.log('turnos'.padEnd(ancho) + corridas.map((c) => col(c.turnos)).join(''));
  console.log('llamadas a la API'.padEnd(ancho) + corridas.map((c) => col(c.llamadas)).join(''));
  console.log('tool calls'.padEnd(ancho) + corridas.map((c) => col(c.toolCalls)).join(''));
  console.log('turnos con thinking'.padEnd(ancho) + corridas.map((c) => col(c.conThinking)).join(''));
  console.log('truncados'.padEnd(ancho) + corridas.map((c) => col(c.truncados)).join(''));
  console.log('segundos'.padEnd(ancho) + corridas.map((c) => col(c.segundos)).join(''));
  console.log('COSTO'.padEnd(ancho) + corridas.map((c) => col('$' + c.costo.toFixed(4))).join(''));

  const base = corridas[0];
  if (corridas.length > 1) {
    console.log('\nvs. ' + base.spec + ':');
    corridas.slice(1).forEach((c) => {
      const pct = ((c.costo - base.costo) / base.costo) * 100;
      console.log('  ' + c.spec.padEnd(28) + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '% de costo');
    });
  }

  console.log('\n### un ejemplo de cada violación (revísalos: hay falsos positivos) ###');
  const vistos = new Set();
  for (const { c, cuenta } of datos) {
    for (const [n, fn] of reglas) {
      if (!cuenta[n]) continue;
      const k = c.spec + '|' + n;
      if (vistos.has(k)) continue;
      for (const [conv, filas] of Object.entries(c.transcripciones)) {
        const f = filas.find((x) => fn(x.bot));
        if (!f) continue;
        vistos.add(k);
        console.log(`\n[${c.spec} / ${n}] en "${conv}"\n  contacto: ${f.contacto}\n  bot: ${(f.bot || '(vacío)').replace(/\s+/g, ' ').slice(0, 200)}`);
        break;
      }
    }
  }
  console.log('\nTruncados > 0 significa que el modelo se quedó sin max_response_tokens.');
  console.log('Si además hay "vacío", el contacto NO recibió nada. Ver lección 25.');
}

(async () => {
  const specs = process.argv.slice(2);
  if (!specs.length) {
    console.error('Uso: npm run test:modelo <modelo> [<modelo> ...]');
    console.error('Modelos: ' + Object.keys(PRECIOS).join(', '));
    console.error('Sufijo opcional ":nothink" para apagar el thinking, ej. claude-sonnet-5:nothink');
    process.exit(1);
  }
  const propio = path.join(__dirname, 'conversaciones.js');
  const archivo = fs.existsSync(propio) ? propio : path.join(__dirname, 'conversaciones.ejemplo.js');
  if (archivo !== propio) {
    console.error('AVISO: usando conversaciones.ejemplo.js (genéricas).');
    console.error('Copia a pruebas/conversaciones.js y escríbelas con los casos REALES del cliente.\n');
  }
  const convs = require(archivo);
  const cfg = getConfig();
  const reglas = bateria(cfg);
  const turnos = convs.reduce((a, [, t]) => a + t.length, 0);

  console.error(`${convs.length} conversaciones, ${turnos} turnos, ${specs.length} modelo(s).`);
  console.error(`Esto gasta crédito real de Anthropic (~$0.50-1.50 USD por modelo). Ctrl-C para abortar.\n`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120000 });
  const corridas = [];
  for (const spec of specs) {
    console.error('corriendo ' + spec + '...');
    corridas.push(await correr(client, spec, convs, cfg));
  }
  const dir = path.join(__dirname, '.resultados');
  fs.mkdirSync(dir, { recursive: true });
  corridas.forEach((c) => fs.writeFileSync(path.join(dir, c.spec.replace(':', '-') + '.json'), JSON.stringify(c, null, 2)));
  reportar(corridas, reglas);
  console.log(`\nTranscripciones completas en pruebas/.resultados/`);
})().catch((e) => { console.error('FALLO:', e.status || '', e.message); process.exit(1); });
