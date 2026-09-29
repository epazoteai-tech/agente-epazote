/**
 * Cargador de configuración del bot.
 *
 * Lee `configuracion/bot.config.yaml` (estructurado) y `configuracion/prompt.md`
 * (texto), valida la estructura con zod y expone helpers para el resto del código.
 *
 * Si el yaml está mal formado o le falta un campo requerido, el bot falla al
 * arrancar con un error claro que indica qué línea/campo arreglar — esto es
 * intencional, mejor fallar rápido y obvio que con un comportamiento raro.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { z } from 'zod';

const CONFIG_DIR = path.resolve(process.cwd(), 'configuracion');
const CONFIG_PATH = path.join(CONFIG_DIR, 'bot.config.yaml');
const PROMPT_PATH = path.join(CONFIG_DIR, 'prompt.md');

const PipelineStageSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  when: z.string().min(1, 'when: describe la regla literal de cuándo mover'),
});

const PipelineSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    stages: z
      .array(PipelineStageSchema)
      .min(1, 'pipeline debe tener al menos 1 etapa configurada')
      .refine(
        (stages) => new Set(stages.map((s) => s.id)).size === stages.length,
        { message: 'Los stage.id deben ser únicos' }
      )
      .refine(
        (stages) => new Set(stages.map((s) => s.name)).size === stages.length,
        { message: 'Los stage.name deben ser únicos (el modelo distingue por nombre)' }
      ),
  })
  .strict();

/**
 * Días de la semana en español → índice de `Date.getDay()` (0 = domingo).
 * Se usa para `calendars.business_hours` y acepta las formas con y sin
 * acento, que es como la gente las escribe en el yaml.
 */
export const DIAS_SEMANA: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  'miércoles': 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  'sábado': 6,
};

const AgendaSchema = z.object({
  name: z.string().min(1),
  calendar_id: z.string().min(1),
  // Opcional: id del usuario de GHL al que se le asigna la cita.
  //
  // Hace falta porque las citas se crean con `ignoreFreeSlotValidation`
  // (ver createAppointment) y en ese modo GHL exige saber a quién asignarla:
  // "A team member needs to be selected. assignedUserId is missing".
  //
  // Si se omite, el bot lo deduce solo del propio calendario (su team member
  // principal) y lo cachea. Ponerlo aquí solo hace falta cuando el calendario
  // tiene varios miembros y quieres uno en particular.
  assigned_user_id: z.string().optional(),
});

const CalendarsSchema = z
  .object({
    timezone: z.string().default('America/Bogota'),
    duration_minutes: z.number().int().positive().default(30),
    // Opcional: duración por TIPO de cita. Cada key es una palabra clave que
    // se busca dentro del motivo (sin acentos, sin distinguir mayúsculas) y
    // el valor son los minutos que dura esa cita. Gana la palabra clave más
    // larga que matchee, para que "obstetrica primera vez" le gane a
    // "primera vez". Si ninguna matchea, se usa `duration_minutes`.
    //
    // Sirve para tener UN solo calendario en GHL con slots cortos y que el
    // bot escriba la duración real de cada cita: GHL bloquea por traslape,
    // así que una cita de 10:00 a 11:00 tumba sola el slot de 10:30.
    durations: z.record(z.string(), z.number().int().positive()).optional(),
    // Opcional: horario REAL de atención, por día de la semana. Cada día es
    // una lista de ventanas "HH:MM-HH:MM" en hora local (timezone de
    // arriba). El bot descarta los slots que GHL devuelva fuera de estas
    // ventanas y se niega a agendar en ellos.
    //
    // Existe porque la disponibilidad de GHL es la configuración del
    // calendario, no el horario del negocio: si el calendario quedó abierto
    // desde las 8am, GHL devuelve las 8am, el bot la ofrece y la cita se
    // cae al agendar. Esto lo corta de raíz, sin depender del prompt.
    //
    // Las ventanas se leen como [inicio, fin): "15:00-17:30" admite citas
    // que EMPIECEN hasta las 17:00, no a las 17:30 (hora de cierre).
    // Un día ausente o con lista vacía = no hay atención ese día.
    business_hours: z
      .record(
        z.string(),
        z.array(
          z
            .string()
            .regex(
              /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/,
              'cada ventana debe ir como "HH:MM-HH:MM" (ej. "09:00-13:00")'
            )
        )
      )
      .optional(),
    // Etapa del pipeline a la que se mueve la opportunity al agendar una
    // cita (opcional — debe existir en pipeline.stages).
    booked_stage: z.string().optional(),
    agendas: z.record(z.string(), AgendaSchema),
    // Routing por palabras clave del motivo. Cada key (en minúsculas) apunta
    // a una agenda, una lista de agendas, o "any" (todas). "default" define
    // qué hacer cuando ninguna palabra clave matchea.
    routing: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .default({ default: 'any' }),
    // Opcional: máximo de citas ACTIVAS (futuras, no canceladas) por
    // contacto. Si se omite, no hay límite. La 2da+ cita debe ir a nombre
    // de una persona distinta a la anterior (asume familiares agendando
    // desde el mismo número).
    max_active_appointments: z.number().int().positive().optional(),
    // Opcional: tag que se agrega al contacto al agendar (para que un
    // Workflow de GHL notifique al equipo — ej. WhatsApp/push al dueño).
    notify_tag: z.string().optional(),
    // Opcional: ID de un custom field de GHL donde el bot escribe el
    // detalle de la cita en texto plano (contacto, motivo, fecha, hora) —
    // útil como merge field en el mensaje de notificación del Workflow.
    detail_field_id: z.string().optional(),
    // ID de un custom field de GHL donde el bot escribe SOLO la fecha legible
    // de la cita ("martes 8 de septiembre a las 4:00 p. m."), para usarla como
    // merge field en la plantilla de recordatorio que le llega al contacto.
    // Se limpia cuando el contacto cancela sin reagendar.
    reminder_date_field_id: z.string().optional(),
  })
  .refine(
    (c) => Object.keys(c.agendas).length > 0,
    'calendars.agendas debe tener al menos una agenda configurada'
  )
  .refine(
    (c) =>
      !c.business_hours ||
      Object.keys(c.business_hours).every((d) => d.trim().toLowerCase() in DIAS_SEMANA),
    'calendars.business_hours: los días deben ser lunes, martes, miercoles, jueves, viernes, sabado o domingo'
  )
  .refine(
    (c) =>
      !c.business_hours ||
      Object.values(c.business_hours)
        .flat()
        .every((rango) => {
          const [ini, fin] = rango.split('-').map(hhmmToMinutes);
          return ini !== null && fin !== null && ini < fin;
        }),
    'calendars.business_hours: en cada ventana "HH:MM-HH:MM" la hora de inicio debe ser menor que la de fin, y ambas válidas (00:00-23:59)'
  );

/**
 * "09:30" → 570 (minutos desde la medianoche). null si no es una hora válida.
 */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const FollowUpsSchema = z
  .object({
    timezone: z.string().default('America/Bogota'),
    // Horario permitido de envío (hora local, 0-23). Fuera de esta ventana
    // los follow-ups se posponen al próximo inicio de ventana (default 8am).
    window_start_hour: z.number().int().min(0).max(23).default(8),
    window_end_hour: z.number().int().min(1).max(24).default(22),
    // Horas después del último mensaje del bot en que se envía cada intento.
    // DEBEN ser < 24: WhatsApp solo permite texto libre dentro de las 24h
    // siguientes al último mensaje del cliente.
    cadence_hours: z.array(z.number().positive().max(23)).min(1).max(3).default([3, 9]),
    // Textos predefinidos de cada follow-up — uno por intento de la cadencia.
    // Soportan {nombre} (primer nombre del contacto, si se conoce).
    messages: z.array(z.string().min(1)).min(1).max(3),
    // Opcional: marcar el lead como perdido moviéndolo a esta etapa del
    // pipeline N horas después (requiere bloque pipeline:). También < 24.
    lost_after_hours: z.number().positive().max(23).optional(),
    lost_stage: z.string().optional(),
    // Opcional: solo hacer follow-up mientras la opportunity siga en esta
    // etapa (la de entrada). Si avanzó (agendó, escaló), se suprime.
    entry_stage: z.string().optional(),
  })
  .refine((f) => f.window_start_hour < f.window_end_hour, {
    message: 'follow_ups: window_start_hour debe ser menor que window_end_hour',
  })
  .refine((f) => f.messages.length === f.cadence_hours.length, {
    message:
      'follow_ups: messages debe tener la misma cantidad de textos que cadence_hours (un mensaje por intento)',
  });

const CustomFieldSchema = z.object({
  // ID interno del campo en GHL (lo pone Andrés durante el setup).
  id: z.string().min(1),
  // Nombre legible — es como el modelo se refiere al campo en la tool.
  name: z.string().min(1),
  // Regla literal de cuándo/qué guardar, en lenguaje natural.
  when: z.string().min(1, 'when: describe cuándo y qué guardar en el campo'),
});

const CustomFieldsSchema = z
  .object({
    fields: z
      .array(CustomFieldSchema)
      .min(1, 'custom_fields debe tener al menos 1 campo configurado')
      .refine(
        (fields) => new Set(fields.map((f) => f.name)).size === fields.length,
        { message: 'Los field.name deben ser únicos (el modelo distingue por nombre)' }
      ),
  })
  .strict();

// Solicitudes de reserva SIN calendario (ver src/services/reservas.ts). El bot
// junta los datos, los guarda en custom fields y pone `notify_tag` para que un
// Workflow de GHL avise al equipo. Nunca confirma la mesa: eso lo hace una
// persona por el mismo chat.
const VentanaReservaSchema = z
  .string()
  .regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/, 'cada ventana debe ir como "HH:MM-HH:MM" (ej. "08:00-23:00"; "24:00" = medianoche)');

const ReservationsSchema = z
  .object({
    timezone: z.string().default('America/Monterrey'),
    // Tag que dispara el Workflow de notificación interna. Se REPONE en cada
    // registro para que el Workflow vuelva a disparar con la 2da reserva.
    notify_tag: z.string().min(1),
    // Desde cuántas personas NO se registra como reserva normal y se escala.
    grupo_grande_desde: z.number().int().min(2),
    // Minutos antes del cierre en que ya no se reciben reservas (0 = hasta el cierre).
    ultima_reserva_antes_de_cierre_min: z.number().int().min(0).default(0),
    // Horario del restaurante por día. Día ausente o lista vacía = cerrado.
    horario: z.record(z.string(), z.array(VentanaReservaSchema)),
    // Cómo se nombra el turno según la hora (solo para el resumen). [desde, hasta).
    turnos: z
      .array(z.object({ nombre: z.string().min(1), desde: z.string(), hasta: z.string() }))
      .default([]),
    // Opcional: etapa del pipeline a la que se mueve la opportunity al registrar.
    stage: z.string().optional(),
    fields: z.object({
      fecha: z.string().min(1),
      hora: z.string().min(1),
      personas: z.string().min(1),
      ocasion: z.string().min(1),
      resumen: z.string().min(1),
      // Opcional: primer mensaje de la sesión (texto precargado del wa.link del
      // creativo). Lo lee la Mesa de Control para el ROAS por creativo.
      origen: z.string().min(1).optional(),
    }),
    // Opcional: endpoint de la Mesa de Control de Epazote. Si está, al
    // registrar cada solicitud se le manda un POST con la reserva (header
    // x-webhook-secret = env MESA_CONTROL_SECRET). Best-effort: si falla, la
    // reserva queda registrada en GHL igual.
    mesa_control_url: z.string().url().optional(),
  })
  .refine(
    (r) => Object.keys(r.horario).every((d) => d.trim().toLowerCase() in DIAS_SEMANA),
    'reservations.horario: los días deben ser lunes, martes, miercoles, jueves, viernes, sabado o domingo'
  );

// Loop-guard: detecta automáticamente que del otro lado hay una máquina y
// manda el contacto a la lista negra (ver src/loop-guard.ts). Va activo por
// defecto — se apaga con `loop_guard: { enabled: false }` en el yaml.
const LoopGuardSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Turnos seguidos en una MISMA ráfaga antes de dar la conversación por
    // artificial. Alto a propósito: una conversación real de agendamiento son
    // 10-20 turnos, así que 40 solo lo alcanza algo que no es una persona.
    max_turns: z.number().int().positive().max(200).default(40),
    // Pausa que reinicia el contador de turnos. Sin esto, un paciente que
    // escribe durante meses acabaría bloqueado por acumulación. Un loop de
    // bots es continuo (segundos entre mensajes), nunca pausa una hora.
    reset_after_minutes: z.number().int().positive().default(60),
    // Responder al bot en menos de estos segundos cuenta como cadencia de
    // máquina. Se mide contra el último mensaje del bot, en el webhook, con
    // la hora real de llegada (no la del historial, que trae el debounce).
    fast_reply_seconds: z.number().int().positive().default(5),
    // Cuántos turnos SEGUIDOS con cadencia de máquina antes de bloquear. Un
    // humano manda un "sí" en 3 segundos una vez; no cinco veces seguidas.
    fast_replies_streak: z.number().int().positive().default(5),
  })
  .strict();

const EscalationSchema = z.object({
  // Tag que se agrega al contacto en GHL al escalar (para workflows del equipo).
  tag: z.string().min(1).default('requiere_humano'),
  // Opcional: etapa del pipeline a la que se mueve la opportunity al escalar.
  stage: z.string().optional(),
});

const ConfigSchema = z.object({
  bot: z.object({
    name: z.string().min(1),
    welcome_message: z.string().min(1),
    // Frase exacta de presentación que el código agrega si el modelo no se
    // presenta al abrir la conversación (E141). Opcional; debe decir
    // "asistente digital" o "asistente virtual".
    presentacion: z
      .string()
      .regex(/asistente\s+(digital|virtual)/i, 'bot.presentacion debe decir "asistente digital" o "asistente virtual"')
      .optional(),
  }),
  business: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
  }),
  // La meta comercial única y medible del agente. Se inyecta en <objetivo>
  // del prompt. Es la sección que separa un bot que contesta de uno que
  // cierra, así que se escribe en términos de RESULTADO contable
  // ("cuántas personas terminan con cita agendada"), no de actitud
  // ("atender bien a los clientes").
  objetivo: z.object({
    meta: z.string().min(1),
  }),
  persona: z.object({
    tone: z.string().min(1),
    language: z.string().min(1),
    audio_language: z.string().min(2).default('es'),
  }),
  rules: z
    .object({
      do_not: z.array(z.string()).default([]),
    })
    .default({ do_not: [] }),
  behavior: z
    .object({
      message_debounce_seconds: z.number().int().positive().default(30),
      worker_concurrency: z.number().int().positive().default(5),
      model: z.string().default('claude-sonnet-4-6'),
      max_response_tokens: z.number().int().positive().default(1024),
    })
    .default({
      message_debounce_seconds: 30,
      worker_concurrency: 5,
      model: 'claude-sonnet-4-6',
      max_response_tokens: 1024,
    }),
  // Datos para el anticipo. Viven aquí y NO tecleados en el prompt: el prompt
  // los renderiza con {{anticipo.datos_bancarios}} y el código verifica que
  // lo que sale al paciente traiga la CLABE y la tarjeta exactas (el modelo
  // puede cambiar un dígito o aplanar el bloque — E63/E96/E118).
  anticipo: z
    .object({
      datos_bancarios: z.string().min(1),
      clabe: z.string().regex(/^\d{18}$/, 'anticipo.clabe: 18 dígitos, sin espacios'),
      tarjeta: z.string().regex(/^\d{16}$/, 'anticipo.tarjeta: 16 dígitos, sin espacios'),
    })
    .optional(),
  pipeline: PipelineSchema.optional(),
  calendars: CalendarsSchema.optional(),
  follow_ups: FollowUpsSchema.optional(),
  escalation: EscalationSchema.optional(),
  loop_guard: LoopGuardSchema.default({}),
  custom_fields: CustomFieldsSchema.optional(),
  reservations: ReservationsSchema.optional(),
})
  // Las etapas del pipeline se referencian POR NOMBRE desde cuatro lugares
  // distintos del yaml, y el código las resuelve por nombre exacto (mayúsculas
  // incluidas). Si un nombre no coincide, el bot NO da error: simplemente deja
  // de mover contactos, y eso se descubre semanas después revisando el CRM a
  // mano. Mejor no arrancar.
  //
  // Ojo con lo que esto NO cubre: si alguien renombra la etapa dentro de GHL,
  // el yaml sigue siendo coherente consigo mismo y esta validación pasa. Ahí
  // el único aviso es el warning de `[pipeline:auto] stage no configurada`
  // en los logs.
  .superRefine((cfg, ctx) => {
    if (!cfg.pipeline) return;
    const nombres = new Set(cfg.pipeline.stages.map((s) => s.name));
    const refs: Array<[string[], string | undefined]> = [
      [['calendars', 'booked_stage'], cfg.calendars?.booked_stage],
      [['escalation', 'stage'], cfg.escalation?.stage],
      [['follow_ups', 'lost_stage'], cfg.follow_ups?.lost_stage],
      [['follow_ups', 'entry_stage'], cfg.follow_ups?.entry_stage],
      [['reservations', 'stage'], cfg.reservations?.stage],
    ];
    for (const [path, valor] of refs) {
      if (valor && !nombres.has(valor)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            `"${valor}" no es ninguna de las etapas de pipeline.stages ` +
            `(${[...nombres].map((n) => `"${n}"`).join(', ')}). ` +
            'Tiene que coincidir EXACTO, mayúsculas y acentos incluidos.',
        });
      }
    }
  });

export type BotConfig = z.infer<typeof ConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineSchema>;
export type PipelineStage = z.infer<typeof PipelineStageSchema>;
export type CalendarsConfig = z.infer<typeof CalendarsSchema>;
export type FollowUpsConfig = z.infer<typeof FollowUpsSchema>;
export type EscalationConfig = z.infer<typeof EscalationSchema>;
export type LoopGuardConfig = z.infer<typeof LoopGuardSchema>;
export type CustomFieldsConfig = z.infer<typeof CustomFieldsSchema>;
export type ReservationsConfig = z.infer<typeof ReservationsSchema>;

let cachedConfig: BotConfig | null = null;
let cachedPrompt: string | null = null;

export function getConfig(): BotConfig {
  if (cachedConfig) return cachedConfig;

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Falta archivo de configuración: ${CONFIG_PATH}\n` +
        `Asegúrate de que la carpeta configuracion/ esté en la raíz del proyecto.`
    );
  }

  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
      `configuracion/bot.config.yaml tiene un error de sintaxis:\n${(err as Error).message}\n` +
        `Revisa la indentación y los dos puntos. Si te trabas, en el classroom hay un video.`
    );
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raíz)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `configuracion/bot.config.yaml es inválido. Revisa estos campos:\n${issues}`
    );
  }

  const ant = parsed.data.anticipo;
  if (ant) {
    const digitos = ant.datos_bancarios.replace(/\D/g, '');
    if (!digitos.includes(ant.clabe) || !digitos.includes(ant.tarjeta)) {
      throw new Error(
        'configuracion/bot.config.yaml: anticipo.datos_bancarios no contiene la misma CLABE y tarjeta ' +
          'que anticipo.clabe / anticipo.tarjeta. Tienen que coincidir.'
      );
    }
  }

  cachedConfig = parsed.data;
  return cachedConfig;
}

function getPromptTemplate(): string {
  if (cachedPrompt !== null) return cachedPrompt;

  if (!fs.existsSync(PROMPT_PATH)) {
    throw new Error(
      `Falta archivo de prompt: ${PROMPT_PATH}\n` +
        `Asegúrate de que la carpeta configuracion/ esté en la raíz del proyecto.`
    );
  }

  cachedPrompt = fs.readFileSync(PROMPT_PATH, 'utf-8');
  return cachedPrompt;
}

function lookup(obj: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Sustituye placeholders en el prompt con valores del config.
 *
 * Soporta:
 *   {{path.to.value}}                          → valor literal
 *   {{#if path}}...{{else}}...{{/if}}          → renderiza una rama u otra según truthy
 *   {{#each list}}...{{this}}...{{/each}}      → repite el bloque por cada item
 *   {{#each list}}...{{this.key}}...{{/each}}  → acceso a propiedades del item
 *
 * El orden de procesamiento (if → each → simples) es importante para que el
 * nesting funcione: un {{#each}} adentro de un {{#if}} solo se renderiza si
 * el #if es truthy.
 */
export function renderPrompt(): string {
  const config = getConfig();
  let prompt = getPromptTemplate();

  // 1. Bloques #if con #else opcional (antes que #each por el nesting).
  // El [\s\S]*? es non-greedy; soporta multi-línea pero no anida #if dentro de #if.
  prompt = prompt.replace(
    /\{\{#if ([\w.]+)\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g,
    (_match, condPath, thenBlock, elseBlock = '') => {
      const value = lookup(config, condPath);
      const truthy =
        value !== undefined &&
        value !== null &&
        value !== false &&
        !(Array.isArray(value) && value.length === 0);
      return truthy ? thenBlock : elseBlock;
    }
  );

  // 2. Bloques #each. Soporta {{this}} (item completo) y {{this.key}} (propiedad).
  prompt = prompt.replace(/\{\{#each ([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_match, listPath, template) => {
    const list = lookup(config, listPath);
    if (!Array.isArray(list)) {
      console.warn(`[config] {{#each ${listPath}}}: no es un array`);
      return '';
    }
    return list
      .map((item) => {
        let out: string = template;
        out = out.replace(/\{\{this\.(\w+)\}\}/g, (_m: string, key: string) =>
          item !== null && typeof item === 'object'
            ? String((item as Record<string, unknown>)[key] ?? '')
            : ''
        );
        out = out.replace(/\{\{this\}\}/g, String(item));
        return out;
      })
      .join('')
      .replace(/\n+$/, '\n');
  });

  // 3. Placeholders simples {{path.to.value}}
  prompt = prompt.replace(/\{\{([\w.]+)\}\}/g, (match, dottedPath) => {
    const value = lookup(config, dottedPath);
    if (value === undefined) {
      console.warn(`[config] Placeholder no encontrado en bot.config.yaml: ${match}`);
      return match;
    }
    return String(value);
  });

  return prompt.trim();
}
