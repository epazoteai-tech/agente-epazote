import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, GhlChannel } from '../types';
import { buildSystemPrompt } from '../prompts/system';
import { getConfig } from '../config';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 60000,
});

/**
 * Lista de herramientas que Claude puede usar.
 *
 * Se construye DINÁMICAMENTE desde configuracion/bot.config.yaml:
 * - Si hay bloque `pipeline:` → se registra `mover_a_etapa` con un `enum` de
 *   los nombres de las etapas configuradas (defensa anti-alucinación).
 *   Las etapas cuya regla `when` empieza con "AUTO" NO se le dan al modelo —
 *   esas las mueve el código (ej. al agendar cita), no la conversación.
 * - Si hay bloque `calendars:` → se registran `consultar_disponibilidad`,
 *   `agendar_cita`, `cliente_frecuente` y `cancelar_cita`.
 * - Si hay bloque `escalation:` → se registra `escalar_a_humano`.
 * - Si hay bloque `reservations:` → se registra `registrar_reserva` (solicitud
 *   de reserva sin calendario; la confirma una persona del equipo).
 * - Si hay bloque `custom_fields:` → se registra `actualizar_campo` con un
 *   `enum` de los nombres de los campos configurados.
 *
 * Para agregar más herramientas en el futuro, agrega su definición acá y su
 * handler en workers/messageWorker.ts.
 */
function buildTools(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [];
  const cfg = getConfig();

  if (cfg.pipeline) {
    const manualStages = cfg.pipeline.stages.filter(
      (s) => !s.when.trim().toUpperCase().startsWith('AUTO')
    );

    if (manualStages.length > 0) {
      const stageNames = manualStages.map((s) => s.name);
      const stagesDesc = manualStages
        .map((s) => `- "${s.name}": ${s.when}`)
        .join('\n');

      tools.push({
        name: 'mover_a_etapa',
        description:
          `Mueve al contacto a otra etapa del pipeline "${cfg.pipeline.name}" de GoHighLevel. ` +
          `Úsala SOLO cuando la conversación cumple literalmente una de estas reglas:\n${stagesDesc}\n\n` +
          `Llámala UNA sola vez por turno. No menciones la llamada al contacto.`,
        input_schema: {
          type: 'object' as const,
          properties: {
            etapa: {
              type: 'string',
              enum: stageNames,
              description: 'Nombre exacto de la etapa destino (debe estar en el enum).',
            },
          },
          required: ['etapa'],
        },
      });
    }
  }

  if (cfg.calendars) {
    const agendaKeys = Object.keys(cfg.calendars.agendas);
    const agendaEnum = [...agendaKeys, 'any'];
    const agendasDesc = agendaKeys
      .map((k) => `"${k}" = ${cfg.calendars!.agendas[k].name}`)
      .join(', ');

    // Hint de routing por palabras clave del motivo (si el dueño lo configuró).
    const routingEntries = Object.entries(cfg.calendars.routing).filter(
      ([k]) => k !== 'default'
    );
    const routingDesc = routingEntries.length
      ? '\nRouting por motivo: ' +
        routingEntries
          .map(([kw, route]) => `si el motivo contiene "${kw}" → ${JSON.stringify(route)}`)
          .join('; ') +
        '.'
      : '';

    tools.push({
      name: 'consultar_disponibilidad',
      description:
        'Consulta horarios de cita disponibles en GoHighLevel. Úsala cuando el contacto ' +
        'quiera agendar o pregunte por horarios. Devuelve una lista de slots crudos ' +
        'con fecha/hora/agenda — tú decides cómo presentarlos (idealmente 2 opciones ' +
        'con doble alternativa). Si la primera semana está llena, la propia herramienta ' +
        'sigue buscando hasta 6 semanas; no hace falta que la vuelvas a llamar por eso.\n\n' +
        `Agendas configuradas: ${agendasDesc}. Usa "any" cuando no haya preferencia clara.${routingDesc}\n` +
        'Si el contacto rechaza las opciones, vuelve a llamar con desde_fecha más adelante.',
      input_schema: {
        type: 'object' as const,
        properties: {
          // Mismo enum cerrado que `agendar_cita` cuando hay `durations`
          // configuradas, y por la misma razón: de aquí sale cuánto dura la
          // cita, y la disponibilidad se filtra para que la cita quepa
          // completa antes del cierre. Si aquí fuera texto libre, el motivo
          // no haría match con la tabla de duraciones, se asumirían 30
          // minutos, y el bot ofrecería un hueco donde una cita de 45 no
          // cabe — para después rechazarla al agendar. Es exactamente el
          // "siempre no se podía" que reportó la Dra.
          motivo: cfg.calendars.durations
            ? {
                type: 'string',
                enum: Object.keys(cfg.calendars.durations),
                description:
                  'Tipo de cita que quiere el contacto. Debe ser EXACTAMENTE uno del enum, ' +
                  'el mismo que después le pasarás a agendar_cita — de ahí sale cuánto dura ' +
                  'y qué huecos sirven. Si el contacto todavía no define cuál, elige el que ' +
                  'mejor corresponda a lo que te contó.',
              }
            : {
                type: 'string',
                description: 'Motivo de la cita tal como lo describió el contacto (ej: "valoración", "asesoría", "demo").',
              },
          agenda: {
            type: 'string',
            enum: agendaEnum,
            description: 'Qué agenda consultar. "any" = cualquiera disponible.',
          },
          desde_fecha: {
            type: 'string',
            description:
              'Fecha mínima a partir de la cual buscar, en formato YYYY-MM-DD. SOLO si el contacto ' +
              'pidió un día específico en este turno ("a partir del martes"). No arrastres la fecha ' +
              'de horarios que ya se habían ofrecido antes: sin este campo se busca desde hoy.',
          },
          horario_preferido: {
            type: 'string',
            enum: ['mañana', 'tarde', 'cualquiera'],
            description: 'Preferencia de horario. "mañana" filtra slots antes de 12pm, "tarde" después de 2pm.',
          },
          cantidad: {
            type: 'number',
            description: 'Cuántos slots devolver. Default 4. Útil pedir más cuando el contacto rechaza varias opciones.',
          },
        },
        required: ['motivo'],
      },
    });

    tools.push({
      name: 'agendar_cita',
      description:
        'Crea la cita en GoHighLevel (se sincroniza con Google Calendar si el calendario está conectado). ' +
        'Úsala SOLO después de que el contacto haya confirmado un slot específico Y te haya dado su nombre completo. ' +
        'El slot_iso debe ser EXACTAMENTE uno de los iso que devolvió consultar_disponibilidad — no inventes horarios.',
      input_schema: {
        type: 'object' as const,
        properties: {
          slot_iso: {
            type: 'string',
            description: 'Fecha y hora ISO de un slot devuelto por consultar_disponibilidad (ej: "2026-05-25T14:00:00-05:00").',
          },
          agenda: {
            type: 'string',
            enum: agendaKeys,
            description: 'Agenda en la que se crea la cita. Debe coincidir con la del slot.',
          },
          nombre_completo: {
            type: 'string',
            description: 'Nombre y apellido del contacto, como lo dictó.',
          },
          // Si el yaml define `calendars.durations`, el motivo deja de ser texto
          // libre y pasa a ser un enum cerrado con los tipos de cita del
          // negocio. Es lo que hace que la duración de cada cita sea
          // determinista: el modelo no puede escribir un motivo que no esté en
          // la tabla, así que resolveDuration() siempre encuentra su match.
          motivo: cfg.calendars.durations
            ? {
                type: 'string',
                enum: Object.keys(cfg.calendars.durations),
                description:
                  'Tipo de cita. Debe ser EXACTAMENTE uno de los valores del enum — ' +
                  'de ahí sale cuánto dura la cita en la agenda.',
              }
            : {
                type: 'string',
                description: 'Motivo de la cita (valoración, asesoría, demo, etc.).',
              },
          es_reagendamiento: {
            type: 'boolean',
            description:
              'true SOLO cuando esta cita reemplaza a una que el contacto ya tenía y que vas a ' +
              'cancelar inmediatamente después con cancelar_cita. Sin esto, el sistema rechaza ' +
              'la cita nueva por duplicar el nombre de la que ya existe.',
          },
        },
        required: ['slot_iso', 'agenda', 'nombre_completo', 'motivo'],
      },
    });

    tools.push({
      name: 'cliente_frecuente',
      description:
        'Consulta el historial de citas del contacto en GoHighLevel para saber si ya fue cliente antes. ' +
        'Llámala cuando el contacto diga algo tipo "ya soy cliente", "ya fui antes", o cuando ' +
        'tengas duda. Devuelve cuántas citas pasadas tiene y cuándo fue la última.',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    });

    tools.push({
      name: 'cancelar_cita',
      description:
        'Cancela la próxima cita agendada del contacto en el calendario. Úsala SOLO en dos casos: ' +
        '(1) el contacto pide explícitamente cancelar su cita, o (2) acabas de agendarle una cita ' +
        'nueva en un reagendamiento y debes cancelar la anterior. NUNCA la uses por iniciativa ' +
        'propia ni ante mensajes ambiguos — si dudas, pregunta primero.\n\n' +
        'No recibe el id de la cita: el sistema resuelve solo cuál cancelar. Si el contacto tiene ' +
        'varias citas próximas y no queda claro cuál, la herramienta te las devuelve con sus fechas ' +
        'para que le preguntes al contacto y la vuelvas a llamar con fecha_cita.',
      input_schema: {
        type: 'object' as const,
        properties: {
          motivo: {
            type: 'string',
            description: 'Por qué se cancela, en 1 frase corta (ej: "reagendó a otro día", "ya no puede asistir"). Opcional.',
          },
          fecha_cita: {
            type: 'string',
            description:
              'SOLO si la herramienta te pidió desambiguar porque hay varias citas próximas: fecha ' +
              'de la cita a cancelar en formato YYYY-MM-DD, tomada de la lista que te devolvió. ' +
              'En el caso normal, omítelo.',
          },
        },
      },
    });
  }

  if (cfg.escalation) {
    tools.push({
      name: 'escalar_a_humano',
      description:
        'Notifica al equipo humano que el contacto necesita atención de una persona. ' +
        'Úsala cuando: el contacto pide hablar con alguien, está molesto, es una urgencia, ' +
        'o detectes algo fuera de tu alcance. Agrega un tag y una nota en GHL — el equipo lo ve ahí. ' +
        'Después de llamarla, dile al contacto con calidez que ya notificaste al equipo.' +
        (cfg.reservations
          ? ' Si lo que quiere es una mesa, pon es_reserva=true y los datos que YA te dio (no se los pidas solo para esto).'
          : ''),
      input_schema: {
        type: 'object' as const,
        properties: {
          motivo_escalacion: {
            type: 'string',
            description: 'Por qué escalas, en 1 frase corta (ej: "pide hablar con persona", "queja fuerte", "caso complejo").',
          },
          ...(cfg.reservations
            ? {
                es_reserva: {
                  type: 'boolean',
                  description:
                    'true si el contacto quiere una mesa que tú no puedes registrar (grupo grande, evento, la reserva ' +
                    'no se pudo registrar). Así queda en la Mesa de Control para que el equipo la confirme. ' +
                    'false para quejas, prensa, empleo, "ya llegué", etc.',
                },
                nombre: { type: 'string', description: 'Solo con es_reserva: nombre que dio el contacto. Vacío si no lo dio.' },
                fecha: { type: 'string', description: 'Solo con es_reserva: YYYY-MM-DD si ya dijo el día. Vacío si no.' },
                hora: { type: 'string', description: 'Solo con es_reserva: HH:MM 24h si ya dijo la hora. Vacío si no.' },
                personas: { type: 'integer', description: 'Solo con es_reserva: cuántas personas, si ya lo dijo.' },
                ocasion: { type: 'string', description: 'Solo con es_reserva: ocasión o detalle (evento, cumpleaños, empresa). Vacío si no.' },
              }
            : {}),
        },
        required: ['motivo_escalacion'],
      },
    });
  }

  if (cfg.reservations) {
    tools.push({
      name: 'registrar_reserva',
      description:
        'Registra una SOLICITUD de reserva y avisa al equipo del restaurante, que es quien la confirma ' +
        'por este mismo chat. NO confirma mesa ni disponibilidad: tú no tienes forma de saber si hay lugar. ' +
        'Llámala UNA vez, solo cuando ya tengas nombre, fecha, hora y número de personas, y ya hayas hecho ' +
        'la pregunta final de ocasión u observaciones (o el contacto ya lo haya dicho). Si falta un dato, ' +
        'pregúntalo primero. Si devuelve error, sigue exactamente lo que dice su "message".',
      input_schema: {
        type: 'object' as const,
        properties: {
          nombre: { type: 'string', description: 'Nombre de quien reserva, como lo dio el contacto.' },
          fecha: { type: 'string', description: 'Fecha de la reserva en formato YYYY-MM-DD, calculada con el contexto temporal.' },
          hora: { type: 'string', description: 'Hora en formato 24h HH:MM (ej. "20:30" para las 8:30 pm).' },
          personas: { type: 'integer', description: 'Número total de personas, incluidos niños.' },
          ocasion: {
            type: 'string',
            description: 'Ocasión u observaciones (cumpleaños, silla para bebé, terraza...). Vacío si no hay.',
          },
        },
        required: ['nombre', 'fecha', 'hora', 'personas'],
      },
    });
  }

  if (cfg.follow_ups) {
    tools.push({
      name: 'cerrar_seguimiento',
      description:
        'Apaga los mensajes de seguimiento automáticos para este contacto. Úsala cuando el ' +
        'contacto declina con claridad ("no gracias", "ya no", "por ahora no", "solo estaba ' +
        'preguntando", "ya me atendieron en otro lado"). NO la uses si el rechazo viene con una ' +
        'alternativa ("no gracias, mejor el martes") ni ante una duda o un "lo voy a pensar". ' +
        'Si más adelante vuelve a pedir horarios, el seguimiento se reactiva solo.',
      input_schema: {
        type: 'object' as const,
        properties: {
          motivo: {
            type: 'string',
            description: 'Qué dijo el contacto, en una frase corta (ej: "dijo que no gracias").',
          },
        },
      },
    });
  }

  if (cfg.custom_fields) {
    const fieldNames = cfg.custom_fields.fields.map((f) => f.name);
    const fieldsDesc = cfg.custom_fields.fields
      .map((f) => `- "${f.name}": ${f.when}`)
      .join('\n');

    tools.push({
      name: 'actualizar_campo',
      description:
        'Guarda un dato en un campo personalizado del contacto en GoHighLevel. ' +
        `Úsala cuando la conversación cumple literalmente una de estas reglas:\n${fieldsDesc}\n\n` +
        'Guarda el valor tal como lo dijo el contacto (limpio, sin comillas ni comentarios tuyos). ' +
        'Puedes llamarla varias veces en un turno si el contacto dio varios datos. ' +
        'No le menciones al contacto que estás guardando nada — es interno.',
      input_schema: {
        type: 'object' as const,
        properties: {
          campo: {
            type: 'string',
            enum: fieldNames,
            description: 'Nombre exacto del campo a actualizar (debe estar en el enum).',
          },
          valor: {
            type: 'string',
            description: 'El valor a guardar, como string (ej: "500 USD", "Bogotá", "2026-08-15").',
          },
        },
        required: ['campo', 'valor'],
      },
    });
  }

  return tools;
}

export const TOOLS: Anthropic.Tool[] = buildTools();

/**
 * Genera contexto temporal (hoy + día de la semana) en la timezone del negocio.
 * Se mete como bloque system NO cacheado — cambia cada día y rompería el cache.
 * Solo se agrega si hay calendars o follow_ups (que son quienes razonan fechas).
 */
function getDateContext(): string {
  const cfg = getConfig();
  const tz = cfg.calendars?.timezone ?? cfg.reservations?.timezone ?? cfg.follow_ups?.timezone ?? 'America/Bogota';
  const now = new Date();
  const human = new Intl.DateTimeFormat('es', {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const hora = new Intl.DateTimeFormat('es', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
  return `<contexto_temporal>\nHoy es ${human} (${iso}), son las ${hora}. Timezone del negocio: ${tz}.\nCuando el contacto diga "mañana", "el viernes", "el próximo lunes", etc., calcula la fecha relativa a este día. Si dice un día con número (ej: "viernes 25"), verifica que el día de la semana y el número coincidan antes de confirmar.\n</contexto_temporal>`;
}

/**
 * Mapea el canal técnico (GhlChannel) a una etiqueta que el modelo usa para
 * decidir si pedir o no número de teléfono antes de agendar/cerrar.
 *
 * - whatsapp_known_number → el bot ya tiene el número (WhatsApp/SMS).
 * - no_phone_yet → entró por canal sin teléfono (FB/IG/Live_Chat/GMB/Email).
 *   El bot DEBE pedir un número antes de agendar o pasar a ventas.
 */
function describeChannel(channel: GhlChannel): string {
  switch (channel) {
    case 'WhatsApp':
    case 'SMS':
      return 'whatsapp_known_number';
    default:
      return 'no_phone_yet';
  }
}

export interface ToolCallResult {
  toolName: string;
  input: Record<string, unknown>;
  output: string;
}

export interface ClaudeResponse {
  text: string;
  toolCalls: ToolCallResult[];
  stopReason: string;
  /**
   * true si la respuesta se cortó (max_tokens, refusal, error de API a media
   * vuelta) y el pedazo se tiró. El worker NO manda silencio: manda una línea
   * neutral y pasa la conversación a una persona (E118).
   */
  cortado: boolean;
  /** Si este turno abre la conversación (mismo corte de sesión que el historial). */
  abre: boolean;
}

/**
 * Cuántas horas sin mensajes cierran una sesión.
 *
 * El historial se recortaba solo por cantidad (`slice(-20)`): a un paciente que
 * regresa semanas después el modelo le seguía la plática vieja como si fuera
 * la de hoy (E83), y como "ya había historial" nunca se le volvía a presentar
 * como asistente digital (E82). 48 h y no menos a propósito: en un consultorio
 * la conversación de agendar dura días (el follow-up sale a las 10 h, el
 * paciente contesta al día siguiente) y cortarla a media negociación sería
 * peor que el error que arregla.
 */
const SESION_HORAS = 48;
const MAX_MENSAJES_CONTEXTO = 20;

/**
 * Mensajes de la sesión vigente (lo que ve el modelo) y si el turno la abre.
 * Lo recortado NO se borra de la base: solo decide qué ve el modelo.
 * `refMs` es el momento contra el que se mide el último hueco: ahora, para un
 * mensaje entrante; el último mensaje, para un follow-up.
 */
export function sesionActual(
  history: ChatMessage[],
  refMs: number
): { mensajes: ChatMessage[]; abre: boolean; horasDesdeUltimo: number | null } {
  const gap = SESION_HORAS * 3600 * 1000;
  const ts = (m: ChatMessage) => new Date(m.ts).getTime();
  if (history.length === 0) return { mensajes: [], abre: true, horasDesdeUltimo: null };

  const ultimo = ts(history[history.length - 1]);
  const horasDesdeUltimo = isNaN(ultimo) ? null : (refMs - ultimo) / 3600000;
  if (!isNaN(ultimo) && refMs - ultimo > gap) {
    return { mensajes: [], abre: true, horasDesdeUltimo };
  }

  let inicio = 0;
  for (let i = history.length - 1; i > 0; i--) {
    const a = ts(history[i - 1]);
    const b = ts(history[i]);
    if (!isNaN(a) && !isNaN(b) && b - a > gap) {
      inicio = i;
      break;
    }
  }
  const mensajes = history.slice(inicio).slice(-MAX_MENSAJES_CONTEXTO);
  return { mensajes, abre: mensajes.length === 0, horasDesdeUltimo };
}

/**
 * Historial → mensajes de la API.
 *
 * - Descarta los de contenido vacío. Un turno sin texto (el filtro se comió
 *   todo, o el modelo cerró solo con tools) se guardaba como
 *   `{role:'assistant', content:''}`, y la API rechaza un mensaje vacío a mitad
 *   del historial: a partir de ahí CADA turno de ese contacto fallaba.
 * - Junta mensajes consecutivos del mismo rol (pasa cuando una persona del
 *   consultorio contestó a mano, o cuando el bot calló un turno).
 */
export function toApiMessages(history: ChatMessage[]): Anthropic.MessageParam[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history) {
    const content = (m.content ?? '').trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  return out;
}

/**
 * Bloque de archivo (foto/pdf) que llega en el turno actual.
 */
export interface AttachmentBlock {
  kind: 'image' | 'pdf';
  base64: string;
  mimeType: string;
}

/**
 * Llama a Claude con historial y herramientas, manejando el ciclo tool_use completo.
 */
export async function getClaudeResponse(
  history: ChatMessage[],
  newMessage: string,
  toolHandler: (name: string, input: Record<string, unknown>) => Promise<string>,
  channel: GhlChannel,
  attachments?: AttachmentBlock[],
  /** Líneas calculadas por el código (ej. las citas reales del contacto). */
  contextoExtra?: string
): Promise<ClaudeResponse> {
  const { mensajes: recentHistory, abre, horasDesdeUltimo } = sesionActual(history, Date.now());

  // Si hay attachments, mandamos un array de bloques (image/document + text).
  // Si no, string simple.
  let currentTurnContent: Anthropic.MessageParam['content'];
  if (attachments && attachments.length > 0) {
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const att of attachments) {
      if (att.kind === 'image') {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: att.base64,
          },
        });
      } else if (att.kind === 'pdf') {
        blocks.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: att.base64,
          },
        });
      }
    }
    blocks.push({ type: 'text', text: newMessage });
    currentTurnContent = blocks;
  } else {
    currentTurnContent = newMessage;
  }

  const previos = toApiMessages(recentHistory);
  // La API junta turnos consecutivos del mismo rol, pero lo hacemos explícito:
  // si el último previo es del contacto (el bot calló ese turno), su texto va
  // pegado al de ahora.
  if (previos.length > 0 && previos[previos.length - 1].role === 'user') {
    const ultimo = previos.pop()!;
    currentTurnContent =
      typeof currentTurnContent === 'string'
        ? `${ultimo.content as string}\n\n${currentTurnContent}`
        : [{ type: 'text', text: ultimo.content as string }, ...currentTurnContent];
  }
  const messages: Anthropic.MessageParam[] = [...previos, { role: 'user', content: currentTurnContent }];

  const lineaApertura = abre
    ? `- ESTE MENSAJE ABRE LA CONVERSACIÓN` +
      (horasDesdeUltimo !== null
        ? ` (el contacto ya había escrito hace ${Math.round(horasDesdeUltimo / 24)} días; salúdalo con familiaridad si ya se conocían)`
        : '') +
      `: tu mensaje tiene que presentarte: "${presentacionDelBot()}"\n`
    : `- La conversación ya está en curso: NO te vuelvas a presentar.\n`;

  // System prompt en bloques:
  // 1. Cacheable (prompt estático): cache_control ephemeral — Anthropic cachea
  //    el prefix del system + tools y reduce ~85% del costo en cache hits.
  // 2. NO cacheables (cambian por turno/día): canal de entrada y fecha de hoy.
  //    Van después para no romper el prefix cacheado.
  const cfgAll = getConfig();
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: buildSystemPrompt(),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        `\n\n---\n## CONTEXTO DEL TURNO (volátil — cambia por canal)\n` +
        `- Canal de entrada: ${channel}\n` +
        `- Estado del teléfono del contacto: ${describeChannel(channel)}\n` +
        lineaApertura +
        (contextoExtra ? `${contextoExtra.trim()}\n` : '') +
        `Si el estado es "no_phone_yet" y vas a agendar una cita o pasar el contacto ` +
        `a una persona del equipo, pídele primero un número de WhatsApp.`,
    },
  ];
  if (cfgAll.calendars || cfgAll.reservations || cfgAll.follow_ups) {
    systemBlocks.push({ type: 'text', text: getDateContext() });
  }

  const toolCalls: ToolCallResult[] = [];
  let finalText = '';
  // Texto que el modelo escribió en un turno que ACABÓ en tool_use: es
  // preámbulo ("voy a revisar..."), no la respuesta al contacto. Se guarda
  // aparte y solo se usa como último recurso si nunca llega un texto final.
  // Texto que el modelo escribió ACOMPAÑANDO una llamada a herramienta.
  //
  // Se guarda aparte porque ahí es donde el modelo narra ("déjame revisar la
  // agenda"), y eso le llegó a una paciente real. Pero NO se tira: también es
  // donde escribe lo que le preguntaron. Si el modelo dice "eso cuesta $2,000,
  // la comunico con una persona" + escala, y después cierra con "ya está
  // avisado el equipo", tirar el preámbulo deja al contacto sin el precio.
  // Se juntan los dos y stripReasoning se encarga de quitar la narración.
  const preambulos: string[] = [];
  let lastStopReason = 'unknown';
  let currentMessages = messages;
  let iterations = 0;
  const MAX_ITERATIONS = 10;
  let reintentoPorCorte = false;
  let cortado = false;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[claude] Iteration ${iterations}/${MAX_ITERATIONS} | msgs=${currentMessages.length} | tools=${TOOLS.length}`);

    const cfg = getConfig().behavior;
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: cfg.model,
        max_tokens: cfg.max_response_tokens,
        system: systemBlocks,
        tools: TOOLS,
        messages: currentMessages,
      });
    } catch (err) {
      console.error(`[claude] API error on iteration ${iterations}:`, (err as Error).message);
      // Solo se propaga (y pg-boss reintenta el turno completo) si todavía no
      // pasó NADA. Si ya corrió alguna tool, reintentar la volvería a ejecutar:
      // una cita agendada dos veces, un reagendamiento que cancela la cita que
      // acaba de crear (E122). Ahí se corta y el worker pasa a una persona.
      if (toolCalls.length === 0 && !finalText && preambulos.length === 0) {
        throw err;
      }
      cortado = true;
      break;
    }

    const u = response.usage;
    const cacheLog = u
      ? ` | in=${u.input_tokens} out=${u.output_tokens} cacheR=${u.cache_read_input_tokens ?? 0} cacheW=${u.cache_creation_input_tokens ?? 0}`
      : '';
    console.log(`[claude] Response | stop=${response.stop_reason} | blocks=${response.content.length}${cacheLog}`);
    lastStopReason = response.stop_reason ?? 'unknown';

    // Cualquier stop_reason que no sea end_turn / tool_use / stop_sequence es
    // un mensaje a medias: max_tokens (se pasó de largo) o refusal (un
    // clasificador frenó la generación en vuelo, más probable justo mientras
    // teclea datos bancarios). Antes el pedazo salía como respuesta terminada:
    // a una paciente le llegó "...un anticipo de $500 por persona, que se le"
    // y ahí terminó (E118). Se reintenta UNA vez; si vuelve a cortarse, el
    // pedazo se tira.
    if (!['end_turn', 'tool_use', 'stop_sequence'].includes(lastStopReason)) {
      if (!reintentoPorCorte) {
        reintentoPorCorte = true;
        console.warn(`[claude] Respuesta cortada (stop=${lastStopReason}) — reintento`);
        continue;
      }
      console.warn(`[claude] Respuesta cortada otra vez (stop=${lastStopReason}) — se descarta el pedazo`);
      cortado = true;
      break;
    }

    const turnText = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('')
      .trim();
    if (turnText) {
      if (response.stop_reason === 'tool_use') preambulos.push(turnText);
      else finalText = turnText;
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const input = block.input as Record<string, unknown>;
        const output = await toolHandler(block.name, input);
        toolCalls.push({ toolName: block.name, input, output });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output,
        });
      }
      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
      continue;
    }

    break;
  }

  if (iterations >= MAX_ITERATIONS && !finalText) {
    console.warn(`[claude] Hit max iterations (${MAX_ITERATIONS}) without final text`);
    cortado = true;
  }

  // El mensaje completo es lo que escribió antes de usar las herramientas MÁS
  // lo que escribió al cerrar, descartando el preámbulo que el cierre ya
  // repite para no decir lo mismo dos veces. Si no hubo cierre (corte de API,
  // max_tokens), el preámbulo solo es mejor que el silencio.
  const piezas = quitarAvisosRepetidos(
    [...preambulos, finalText]
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t, i, todas) => !todas.slice(i + 1).some((otra) => otra.includes(t)))
  );
  const completo = piezas.join('\n\n');

  const { text: cleanText, removed } = stripReasoning(completo);
  if (removed.length > 0) {
    console.warn(
      `[claude] Razonamiento interceptado (${removed.length} frag): ` +
        removed.map((r) => JSON.stringify(r.slice(0, 160))).join(' | ')
    );
  }
  if (completo && !cleanText) {
    console.error(
      `[claude] Respuesta 100% narración — el worker manda la línea neutral: ${JSON.stringify(completo.slice(0, 300))}`
    );
  }

  return { text: cleanText, toolCalls, stopReason: lastStopReason, cortado, abre };
}

/**
 * Genera el texto de un follow-up CONTEXTUAL — en vez de mandar el mensaje
 * predefinido del yaml tal cual, le pasamos a Claude toda la conversación
 * real y le pedimos que retome exactamente lo que quedó pendiente (un dato
 * que faltaba, un horario sin confirmar, una duda sin resolver).
 *
 * Es una llamada de SOLO TEXTO — sin tools — para que nunca intente agendar,
 * mover de etapa, etc. por su cuenta en un mensaje que el contacto no inició.
 *
 * Si esto falla (red, rate limit, etc.), el caller debe usar como respaldo
 * el mensaje predefinido de `follow_ups.messages` — por eso esta función
 * lanza el error en vez de tragárselo.
 */
export async function generateFollowUpMessage(
  history: ChatMessage[],
  attempt: number,
  totalAttempts: number,
  hoursIdle: number,
  nombre = ''
): Promise<string> {
  // Mismo corte de sesión que la conversación, medido contra el último mensaje
  // (medido contra ahora daría vacío: el follow-up sale horas después).
  const ultimoMs = history.length ? new Date(history[history.length - 1].ts).getTime() : Date.now();
  const { mensajes: recentHistory } = sesionActual(history, isNaN(ultimoMs) ? Date.now() : ultimoMs);

  const instruction =
    `[INSTRUCCIÓN INTERNA DE SEGUIMIENTO — esto NO es un mensaje del contacto, no lo trates como tal ni le respondas como si él hubiera escrito esto]\n` +
    `El contacto dejó de responder hace aproximadamente ${Math.round(hoursIdle)} horas. Este es tu mensaje de seguimiento #${attempt} de ${totalAttempts} máximo antes de dejarlo en paz.\n` +
    `Genera SOLO el texto exacto que le vas a mandar por WhatsApp — nada de explicaciones tuyas, nada de herramientas, nada de meta-comentarios.\n` +
    // Pedido de Epazote (08/10/2026): el seguimiento llegaba seco, directo a la
    // pregunta. Primero un saludo amable con su nombre, después la pregunta.
    `Tono: muy amable y cálido. Empieza saludando otra vez, con su nombre si lo tienes ` +
    `(${nombre ? `su perfil dice "${nombre}"; ` : ''}si en la conversación dio su nombre, usa ese), ` +
    `por ejemplo "Hola ${nombre || '[nombre]'}, qué gusto saludarte de nuevo!". Si no tienes su nombre, saluda sin nombre. ` +
    `Ya después del saludo haz la pregunta.\n` +
    `Basándote en TODA la conversación de arriba, retoma exactamente lo que quedó pendiente: si faltaba un dato para agendar (nombre, horario, motivo), pídelo de forma concreta; si estaba viendo información de algo específico y no llegó a cerrar, retómalo conectado a lo que preguntó; si ya tenía horarios ofrecidos sin elegir, recuérdaselos. NO hagas una pregunta genérica tipo "¿pudiste ver la información?" a menos que genuinamente eso sea lo único que quedó pendiente — sé específico al contexto real de esta conversación.\n` +
    `Si por el contexto de la conversación es claro que este contacto NO es un cliente/paciente real (ej. es un proveedor ofreciendo un servicio, publicidad, spam, un número equivocado, alguien buscando trabajo), no generes ningún mensaje de seguimiento. En ese caso responde ÚNICAMENTE con el texto exacto NO_FOLLOW_UP (sin comillas, sin explicación, sin nada más alrededor) — nunca expliques tu razonamiento como si fuera el mensaje a enviar.`;

  const previos = toApiMessages(recentHistory);
  // Si lo último es del contacto, la instrucción se le pega (dos turnos user seguidos).
  const messages: Anthropic.MessageParam[] =
    previos.length > 0 && previos[previos.length - 1].role === 'user'
      ? [...previos.slice(0, -1), { role: 'user', content: `${previos[previos.length - 1].content as string}\n\n${instruction}` }]
      : [...previos, { role: 'user', content: instruction }];

  const cfgAll = getConfig();
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } },
  ];
  if (cfgAll.calendars || cfgAll.reservations || cfgAll.follow_ups) {
    systemBlocks.push({ type: 'text', text: getDateContext() });
  }

  const cfg = getConfig().behavior;
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: cfg.max_response_tokens,
    system: systemBlocks,
    messages,
    // Sin tools a propósito: esto es generación de texto puro.
  });

  // Un follow-up cortado no se manda a medias: se cae al respaldo del yaml.
  if (response.stop_reason !== 'end_turn' && response.stop_reason !== 'stop_sequence') {
    throw new Error(`follow-up cortado (stop=${response.stop_reason})`);
  }

  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as Anthropic.TextBlock).text)
    .join('')
    .trim();

  // El sentinel NO_FOLLOW_UP pasa intacto (no matchea ningún patrón); lo que
  // se filtra acá es la otra mitad del mismo bug: que el modelo devuelva su
  // análisis como si fuera el texto a mandar. Si no queda nada, el worker cae
  // al mensaje predefinido del yaml.
  const { text, removed } = stripReasoning(raw);
  if (removed.length > 0) {
    console.warn(
      `[follow-up] Razonamiento interceptado (${removed.length} frag): ` +
        removed.map((r) => JSON.stringify(r.slice(0, 160))).join(' | ')
    );
  }
  return text;
}

/**
 * Frases que delatan que el modelo está NARRANDO su razonamiento en vez de
 * hablarle al paciente.
 *
 * Existe porque el prompt ya lo prohíbe (reglas 5 y 6 de disponibilidad) y aun
 * así se fugó: el 14/09/2026 una paciente recibió "El slot de las 10:00am del
 * martes 22 no aparece disponible. Tengo que avisarle a Josefina antes de
 * confirmarle ese horario." pegado arriba de la respuesta real. Una regla de
 * prompt falla de forma probabilística; esto es el cinturón de seguridad en
 * código, igual que normalizeWhatsAppFormat lo es para el markdown.
 *
 * Criterio para agregar un patrón acá: tiene que ser algo que una asistente
 * humana JAMÁS le escribiría a un paciente. Un falso positivo borra un párrafo
 * bueno, así que se prefiere precisión sobre cobertura.
 */
const NARRACION_PATTERNS: RegExp[] = [
  // Vocabulario del sistema — nombres de tools y de sus parámetros.
  /\b(consultar_disponibilidad|agendar_cita|cancelar_cita|cliente_frecuente|escalar_a_humano|mover_a_etapa|actualizar_campo)\b/i,
  /\b(tool_use|tool_result|slot_iso|desde_fecha|horario_preferido|es_reagendamiento|appointment_id)\b/i,
  // "slot" no es una palabra que se le diga a un paciente en español.
  /\bslots?\b/i,
  // Habla del interlocutor en tercera persona NARRANDO lo que hizo o quiere.
  //
  // Ojo con la versión ancha de este patrón —`(el|la|del|al) (paciente|contacto)`
  // a secas—: se comía preguntas legítimas como "me comparte el nombre y la
  // fecha de nacimiento de la paciente?", que en este consultorio son
  // obligatorias porque quien escribe no siempre es quien se atiende. En una
  // prueba el bot acabó sin mandar NADA. Tiene que venir un verbo de
  // narración detrás para que cuente.
  /\b(el|la)\s+(paciente|contacto)\s+(ya|no|s[ií]|me|le|quiere|dice|dijo|pidi[oó]|mencion[oó]|tiene|est[aá]|acaba|eligi[oó]|confirm[oó]|prefiere)\b/i,
  /\b(avisarle|decirle|preguntarle|confirmarle|comentarle|explicarle|responderle|mandarle|ofrecerle)\s+a\s+[A-ZÁÉÍÓÚÑ]/,
  // Anuncia que va a revisar en vez de revisar en silencio.
  /\b(d[eé]jame|d[eé]jeme|perm[ií]teme|perm[ií]tame)\s+(verificar|revisar|consultar|checar|validar|notificarle|notificar|avisarle|comunicarle)\b/i,
  // Cita a la herramienta como fuente.
  /\b(seg[uú]n|como (muestra|dice)|me (sale|salen|aparece|aparecen))\s+(la\s+|el\s+)?(herramienta|disponibilidad|el sistema|el calendario)\b/i,
  // Aperturas típicas de corrección interna.
  /^(bueno|ok|a ver|entonces)[,:]?\s+(los horarios|lo que|tengo que|debo|primero|voy a)\b/i,
];

function esNarracion(fragmento: string): boolean {
  return NARRACION_PATTERNS.some((re) => re.test(fragmento));
}

/**
 * Quita del texto los párrafos que son razonamiento interno, dejando solo lo
 * que va dirigido al paciente.
 *
 * Trabaja por párrafos (separados por línea en blanco). Si un párrafo marcado
 * como narración trae varias líneas y no es una lista, se intenta rescatar
 * línea por línea antes de tirarlo completo — así no se pierde la respuesta
 * real cuando el modelo la pegó abajo de su narración con un solo salto.
 *
 * Devuelve también lo que quitó, para poder loguearlo y detectar el patrón.
 */
export function stripReasoning(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const parrafos = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const parrafo of parrafos) {
    if (!esNarracion(parrafo)) {
      kept.push(parrafo);
      continue;
    }

    const lineas = parrafo.split('\n').map((l) => l.trim()).filter(Boolean);
    const esLista = lineas.some((l) => /^([•\-*]|\d+[.)])\s/.test(l));
    if (lineas.length > 1 && !esLista) {
      const limpias = lineas.filter((l) => {
        if (esNarracion(l)) {
          removed.push(l);
          return false;
        }
        return true;
      });
      if (limpias.length > 0) {
        kept.push(limpias.join('\n'));
        continue;
      }
    } else {
      removed.push(parrafo);
      continue;
    }
  }

  return { text: kept.join('\n\n').trim(), removed };
}

/**
 * Normaliza el formato al que sí entiende WhatsApp.
 *
 * El modelo escribe markdown por costumbre (`**negrita**`) y WhatsApp lo
 * muestra con los asteriscos literales — le llegó así a contactos reales.
 * El prompt ya lo prohíbe, pero esto es el cinturón de seguridad: sea cual
 * sea el modelo o el turno, al contacto le llega el formato correcto.
 */
export function normalizeWhatsAppFormat(text: string): string {
  return text
    // **negrita** → *negrita* (WhatsApp usa un solo asterisco)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '*$1*')
    // ### Encabezados de markdown: no existen en WhatsApp
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    // Signos de apertura. La regla lleva años escrita en el prompt y en
    // rules.do_not, y aun así se cuela — sobre todo en el saludo, que es la
    // primera línea que lee TODO contacto nuevo, o sea que cuando falla, falla
    // en el 100% de las conversaciones que empiezan ese día. Una regla
    // puramente mecánica se cumple en código el 100% de las veces; el prompt
    // se queda de cinturón (lección E128 de la skill errores-bot).
    //
    // Si algún cliente futuro SÍ quiere los signos de apertura, esta línea es
    // la que hay que quitar, junto con las dos reglas del yaml y del prompt.
    .replace(/[¿¡]/g, '');
}

/**
 * Divide el texto en hasta 3 partes para WhatsApp. Corta preferentemente en
 * separación de párrafos para no partir listas a la mitad.
 */
export function splitMessage(text: string, maxChars = 800): string[] {
  const clean = normalizeWhatsAppFormat(text).trim();
  if (clean.length <= maxChars) return [clean];

  const parts: string[] = [];
  let remaining = clean;

  while (remaining.length > 0 && parts.length < 3) {
    if (remaining.length <= maxChars || parts.length === 2) {
      parts.push(remaining);
      break;
    }

    let cut = remaining.lastIndexOf('\n\n', maxChars);
    if (cut > maxChars * 0.3) {
      cut += 2;
    } else {
      cut = remaining.lastIndexOf('\n', maxChars);
      while (cut > 0 && /^\s*[•\-\*]/.test(remaining.slice(cut + 1))) {
        cut = remaining.lastIndexOf('\n', cut - 1);
      }
      if (cut > maxChars * 0.3) cut += 1;
      else {
        cut = remaining.lastIndexOf('. ', maxChars);
        if (cut > maxChars * 0.3) cut += 2;
        else {
          // Último respaldo: corta en el espacio más cercano antes del
          // límite, para nunca partir una palabra a la mitad (ej. "rango
          // d|e precio"). Solo cae al corte duro si de plano no hay ni un
          // espacio en todo el rango (prácticamente imposible en texto real).
          cut = remaining.lastIndexOf(' ', maxChars);
          if (cut <= 0) cut = maxChars;
        }
      }
    }

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  return parts.filter(p => p.length > 0);
}

// ─── Revisiones sobre el texto que va a salir ────────────────────────────────
//
// Reglas que el prompt ya pide y que el modelo rompe de forma probabilística.
// Si romperlas le cuesta algo al paciente, se revisan aquí en código.

/**
 * Si el turno abre la conversación y el mensaje no dice que es un asistente
 * digital, se lo agrega. La regla estaba escrita tres veces en el prompt y el
 * modelo la omitía igual (E141).
 *
 * Si el mensaje ya saluda, la presentación va DESPUÉS del saludo (anteponerla
 * haría un saludo doble). A media conversación no se toca nada.
 */
/**
 * Cómo se presenta el bot. `bot.presentacion` en el yaml si se definió (para
 * ajustar la gramática: "del Dr. Miguel", "de la Dra. Mariana"); si no, una
 * genérica. Tiene que incluir "asistente digital" o "virtual": es la palabra
 * que hace el trabajo (E107).
 */
export function presentacionDelBot(): string {
  const cfg = getConfig();
  return cfg.bot.presentacion ?? `Soy ${cfg.bot.name}, asistente digital de ${cfg.business.name}.`;
}

export function asegurarPresentacion(text: string, abre: boolean): string {
  if (!abre || !text.trim()) return text;
  if (/asistente\s+(digital|virtual)/i.test(text)) return text;

  const presentacion = presentacionDelBot();
  const saludo = text.match(
    /^\s*(hola|buen[oa]s?\s+(d[ií]as|tardes|noches)|qu[eé]\s+tal)[^.!?\n]*[.!?]*[ \t]*/i
  );
  if (saludo) {
    const resto = text.slice(saludo[0].length).trimStart();
    return `${saludo[0].trimEnd()} ${presentacion}${resto ? ` ${resto}` : ''}`;
  }
  return `Hola! ${presentacion} ${text.trimStart()}`;
}

/**
 * Si el mensaje trae datos bancarios, verifica que la CLABE y la tarjeta sean
 * las del yaml, dígito por dígito, y que vayan en renglones propios. Si no,
 * cambia esos renglones por el bloque exacto.
 *
 * El modelo teclea el bloque de memoria en cada conversación: puede cambiar un
 * dígito (el pago se va a otra cuenta o rebota) o aplanarlo en un párrafo que
 * no se puede copiar (E63/E96).
 */
const RENGLON_BANCARIO = /^\s*[*_]*\s*(banco|tarjeta|clabe|cuenta|nombre|titular|beneficiario)\b.*$/i;

export function asegurarDatosBancarios(text: string): string {
  const ant = getConfig().anticipo;
  if (!ant) return text;
  const hablaDeBanco =
    // Solo cuando de verdad trae datos: "haz la transferencia a la cuenta que te
    // pasé" no debe disparar un reenvío del bloque.
    /\b(clabe|banorte)\b/i.test(text) || /(\d[\s-]?){16,}/.test(text);
  if (!hablaDeBanco) return text;

  const lineas = text.split('\n');
  const digitos = text.replace(/\D/g, '');
  const bloqueOk = ant.datos_bancarios
    .trim()
    .split('\n')
    .every((l) => lineas.some((x) => x.trim() === l.trim()));
  if (digitos.includes(ant.clabe) && digitos.includes(ant.tarjeta) && bloqueOk) return text;

  // Quita cualquier renglón con datos bancarios (o con 16+ dígitos) y pone el
  // bloque exacto donde estaba el primero.
  const bloque = ant.datos_bancarios.trim();
  const salida: string[] = [];
  let insertado = false;
  for (const l of lineas) {
    const esBancario =
      RENGLON_BANCARIO.test(l) ||
      /(\d[\s-]?){16,}/.test(l) ||
      /\b(banorte|clabe)\b/i.test(l);
    if (esBancario) {
      if (!insertado) {
        salida.push(bloque);
        insertado = true;
      }
      continue;
    }
    salida.push(l);
  }
  if (!insertado) salida.push('', bloque);
  console.warn('[anticipo] los datos bancarios del modelo no coincidían con el yaml — se reemplazaron por el bloque exacto');
  return salida.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * ¿El texto le dice al contacto que ya se avisó a una persona?
 *
 * Si lo dice y en ese turno no se escaló, el contacto se queda esperando a
 * alguien que nunca fue notificado (E66). El worker escala en código.
 */
const HANDOFF = new RegExp(
  [
    'ya (le |te |les )?(avis[eé]|notifiqu[eé]|coment[eé]) (al|a la|a una|con el|a alguien)',
    // En plural ("ya les avisé") no trae complemento: el sujeto es el equipo.
    'ya les (avis[eé]|notifiqu[eé]|pas[eé])',
    'una persona (del equipo )?(te|le) (escribe|contacta|atiende|llama)',
    'ya (le |te )?pas[eé] (tu|su) (mensaje|caso|comprobante|informaci[oó]n)',
    '(le|te) (aviso|notifico|paso) (al equipo|a una persona|al doctor)',
    'en (breve|un momento|un rato|seguida) (te|le|la|lo) (contacta|escribe|atiende|confirma|llama)',
    'una persona del (equipo|consultorio|negocio) (te|le|la|lo) ',
    'ya (lo|la) tiene el equipo',
  ].join('|'),
  'i'
);

export function pareceHandoff(text: string): boolean {
  return HANDOFF.test(text);
}


// Una oración que avisa que el equipo ya está enterado / que alguien escribe.
const AVISO_AL_EQUIPO = /(avis[eé]|\baviso\b|el equipo ya|ya (lo|la) tiene|ya (lo|la) sabe|en el radar|lo van a revisar|(te|le) (escribe|contacta|confirma)n?\b)/i;
const ORACIONES = /[^.!?\n]+[.!?]*\s*/g;

/**
 * Cuando el modelo escribe ANTES de usar una herramienta y otra vez DESPUÉS, el
 * aviso al equipo sale dos veces con otras palabras: "Ya lo tiene el equipo 👍 ⏎
 * El equipo ya lo tiene y lo van a revisar" (Epazote, 05/10/2026, en cada
 * escalación). El filtro de arriba solo quita repeticiones idénticas. Aquí, entre
 * todas las piezas del turno, el aviso se queda la PRIMERA vez y las oraciones
 * de aviso que vienen después se quitan; si una pieza se queda vacía, sale.
 * Solo aplica cuando hay más de una pieza (o sea, hubo herramienta de por medio).
 */
export function quitarAvisosRepetidos(piezas: string[]): string[] {
  if (piezas.length < 2) return piezas;
  let yaAviso = false;
  return piezas
    .map((p) =>
      (p.match(ORACIONES) ?? [p])
        .filter((o) => {
          if (!AVISO_AL_EQUIPO.test(o)) return true;
          if (yaAviso) return false;
          yaAviso = true;
          return true;
        })
        .join('')
        .trim()
    )
    .filter(Boolean);
}
