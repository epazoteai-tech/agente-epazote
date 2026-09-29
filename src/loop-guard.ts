/**
 * Loop-guard: detecta que del otro lado de la conversación hay una máquina y
 * manda el contacto a la lista negra permanente.
 *
 * El problema que resuelve: dos bots se responden infinitamente. Cada vuelta
 * cuesta tokens de Claude y ensucia el pipeline de GHL con un "lead" que no
 * es una persona. Nadie se entera hasta que alguien revisa la factura.
 *
 * Corta por dos señales independientes, cualquiera de las dos basta:
 *
 *   1. TURNOS — más de `max_turns` turnos seguidos sin una pausa larga. Una
 *      conversación real de agendamiento son 10-20 turnos y siempre tiene
 *      pausas (la persona come, trabaja, duerme). El contador se reinicia
 *      tras `reset_after_minutes` de silencio, así que un paciente recurrente
 *      que escribe durante meses nunca lo acumula.
 *
 *   2. CADENCIA — `fast_replies_streak` turnos SEGUIDOS en los que el otro
 *      lado contestó en menos de `fast_reply_seconds`. Un humano manda un
 *      "sí" en tres segundos una vez; no cinco veces seguidas.
 *
 * Se evalúa en el webhook, ANTES de escribir en la base, de pedir media a la
 * API de GHL y de encolar: el turno que dispara la detección ya no gasta un
 * solo token. A partir de ahí el contacto queda bloqueado en la base y todo
 * lo que mande se ignora en silencio, sin tag y sin escalar a nadie.
 *
 * Se ajusta en el bloque `loop_guard:` de configuracion/bot.config.yaml.
 */

import { LoopGuardConfig } from './config';

/** Estado del contacto leído de la base, justo antes de procesar un entrante. */
export interface EstadoContacto {
  last_bot_message_at: Date | null;
  last_activity: Date | null;
  turn_count: number;
  fast_replies: number;
  fast_reply_marker: Date | null;
}

export interface ResultadoLoopGuard {
  /** Contadores ya actualizados con este entrante — se persisten en el upsert. */
  turnCount: number;
  fastReplies: number;
  fastReplyMarker: Date | null;
  /** Motivo del bloqueo, o null si la conversación se ve humana. */
  motivoBloqueo: string | null;
}

const MINUTO_MS = 60 * 1000;

/**
 * Actualiza los contadores del contacto con el mensaje que acaba de llegar y
 * dice si hay que bloquearlo. Función pura: no toca la base ni la config
 * global, así se puede probar con estados armados a mano.
 */
export function evaluarLoop(
  estado: EstadoContacto | null,
  cfg: LoopGuardConfig,
  ahoraMs: number = Date.now()
): ResultadoLoopGuard {
  const previo: EstadoContacto = estado ?? {
    last_bot_message_at: null,
    last_activity: null,
    turn_count: 0,
    fast_replies: 0,
    fast_reply_marker: null,
  };

  // --- Señal 1: turnos de la ráfaga actual ---
  const ultimaActividad = previo.last_activity?.getTime() ?? null;
  const huboPausaLarga =
    ultimaActividad === null || ahoraMs - ultimaActividad > cfg.reset_after_minutes * MINUTO_MS;
  const turnCount = huboPausaLarga ? 1 : (previo.turn_count ?? 0) + 1;

  // --- Señal 2: cadencia de respuesta ---
  // Se mide contra el último mensaje del bot y SOLO una vez por turno suyo:
  // si la persona manda tres mensajes seguidos, esa ráfaga cuenta como uno.
  // Sin el marker, un humano normal que escribe "hola" / "quiero info" /
  // "de facial" en diez segundos acumularía tres respuestas "de máquina".
  const ultimoBot = previo.last_bot_message_at?.getTime() ?? null;
  const yaMedidoEsteTurno =
    ultimoBot !== null && previo.fast_reply_marker?.getTime() === ultimoBot;

  let fastReplies = previo.fast_replies ?? 0;
  let fastReplyMarker = previo.fast_reply_marker;

  if (ultimoBot !== null && !yaMedidoEsteTurno) {
    const segundos = (ahoraMs - ultimoBot) / 1000;
    fastReplies = segundos <= cfg.fast_reply_seconds ? fastReplies + 1 : 0;
    fastReplyMarker = new Date(ultimoBot);
  }

  // --- Veredicto ---
  let motivoBloqueo: string | null = null;
  if (cfg.enabled) {
    if (turnCount >= cfg.max_turns) {
      motivoBloqueo =
        `loop: ${turnCount} turnos seguidos sin pausa de ${cfg.reset_after_minutes} min`;
    } else if (fastReplies >= cfg.fast_replies_streak) {
      motivoBloqueo =
        `cadencia de máquina: ${fastReplies} respuestas seguidas en menos de ${cfg.fast_reply_seconds}s`;
    }
  }

  return { turnCount, fastReplies, fastReplyMarker, motivoBloqueo };
}
