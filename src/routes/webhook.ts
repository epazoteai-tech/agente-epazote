import { Router, Request, Response, NextFunction } from 'express';
import { enqueueMessage } from '../queue';
import { db } from '../db/client';
import { GHLWebhookPayload, GhlChannel } from '../types';
import { incorporarInboundNuevos } from '../services/inbound';
import { contactoBloqueado, bloquearContacto } from '../blocklist';
import { evaluarLoop, EstadoContacto } from '../loop-guard';
import { cancelarFollowUpsPendientes } from '../services/follow-up';
import { getConfig } from '../config';

export const webhookRouter = Router();

/**
 * Un webhook INDEPENDIENTE por canal, con el canal hardcodeado en la ruta:
 *
 *   POST /webhook/ghl/whatsapp   → WhatsApp
 *   POST /webhook/ghl/facebook   → FB (Messenger)
 *   POST /webhook/ghl/instagram  → IG (DM)
 *   POST /webhook/ghl            → WhatsApp (compat con bots ya deployados)
 *
 * En GHL se configura un Workflow por canal, cada uno apuntando a SU URL y
 * con el trigger filtrado por ese canal. Detectar el canal dinámicamente
 * desde el payload resulta frágil — hardcodearlo por ruta garantiza que el
 * bot siempre responde por el canal correcto.
 */
function makeGhlWebhookHandler(channel: GhlChannel) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Defensa anti-spoofing: si WEBHOOK_SECRET está seteado, exigir que GHL
    // mande el header `x-webhook-secret` con el mismo valor. Si la env var
    // está vacía/ausente, el handler permite todo (opt-out — solo para compat
    // con instalaciones previas; la skill setea el secret en el deploy).
    const expectedSecret = process.env.WEBHOOK_SECRET;
    if (expectedSecret) {
      const providedSecret = req.header('x-webhook-secret');
      if (providedSecret !== expectedSecret) {
        const ua = req.header('user-agent') ?? 'unknown';
        console.warn(`[webhook:${channel}] Unauthorized | ua="${ua}"`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    // Responder 200 inmediatamente — GHL exige respuesta en menos de 5 segundos
    res.status(200).json({ received: true });
    try {
      const payload = req.body as GHLWebhookPayload;

      const contactId = payload.contact_id;
      const messageText = payload.message?.body?.trim() ?? '';
      const phone = payload.phone ?? '';
      const contactName = payload.full_name ?? payload.first_name ?? null;

      if (!contactId) {
        console.log(`[webhook:${channel}] Skipped — sin contactId`);
        return;
      }

      // Corte total para contactos en la lista negra (ver src/blocklist.ts).
      // Se descarta ANTES de escribir en la base y de encolar: no se guarda
      // historial, no se llama a Claude y no se responde nada. Silencio total
      // — si contestamos aunque sea una vez, el bot del otro lado sigue.
      // La lista estática se chequea primero porque no cuesta ni una query.
      if (contactoBloqueado(contactId, phone)) {
        console.log(`[webhook:${channel}] Bloqueado — blocklist estática | contact=${contactId} phone=${phone}`);
        return;
      }

      // Estado previo del contacto: el bloqueo automático y las señales que
      // el loop-guard necesita para decidir si del otro lado hay una máquina.
      const estadoRes = await db.query<EstadoContacto & { blocked_at: Date | null }>(
        `SELECT blocked_at, last_bot_message_at, last_activity,
                turn_count, fast_replies, fast_reply_marker
         FROM conversations WHERE contact_id = $1`,
        [contactId]
      );
      const estado = estadoRes.rows[0] ?? null;

      if (estado?.blocked_at) {
        console.log(`[webhook:${channel}] Bloqueado — blocklist automática | contact=${contactId}`);
        return;
      }

      // Loop-guard (ver src/loop-guard.ts). Corre aquí arriba a propósito: el
      // turno que dispara la detección no llega a pedir media a GHL, ni a la
      // cola, ni a Claude. Cero tokens gastados en el mensaje que delata.
      const guard = evaluarLoop(estado, getConfig().loop_guard);
      if (guard.motivoBloqueo) {
        await bloquearContacto(contactId, guard.motivoBloqueo);
        await cancelarFollowUpsPendientes(contactId).catch(() => {});
        console.warn(
          `[webhook:${channel}] Loop detectado, contacto a lista negra | ` +
            `contact=${contactId} phone=${phone} motivo="${guard.motivoBloqueo}"`
        );
        return;
      }

      // El texto NO sale del payload: sale de la API de GHL (E144).
      //
      // GHL no dispara el webhook de todos los mensajes. Medido en Viking Food:
      // 1 de cada 5 se perdía, y todos los perdidos llegaron dentro de 6
      // segundos del anterior — justo lo que alguien escribe después de "hola"
      // ("hola" + "mesa para 4 mañana a las 9"). Así que el webhook pasa a ser
      // el timbre: solo dice "pasó algo con este contacto", y qué pasó se le
      // pregunta a GHL (`services/inbound.ts`), que además trae el adjunto de
      // CADA mensaje, no solo del último (E23).
      //
      // Los contadores del loop-guard se guardan aparte (antes iban en el mismo
      // upsert del pendiente): cuentan este webhook aunque el texto ya lo haya
      // incorporado otra puerta.
      const guardarGuard = () =>
        db
          .query(
            `UPDATE conversations SET turn_count = $2, fast_replies = $3, fast_reply_marker = $4 WHERE contact_id = $1`,
            [contactId, guard.turnCount, guard.fastReplies, guard.fastReplyMarker]
          )
          .catch((e) => console.warn(`[webhook:${channel}] no se guardó el loop-guard: ${(e as Error).message}`));

      let textForClaude: string;
      let conMedia = false;
      try {
        const inc = await incorporarInboundNuevos(contactId, { phone, contactName, channel });
        await guardarGuard();
        if (inc.incorporados.length === 0) {
          // Ya estaban incorporados (otro webhook de la misma ráfaga, el inicio
          // del turno o el barrido). Encolar otra vez solo daría un turno vacío.
          console.log(`[webhook:${channel}] Skipped — nada nuevo que incorporar | contact=${contactId}`);
          return;
        }
        textForClaude = inc.texto;
        conMedia = inc.incorporados.some((m) => m.attachment);
        if (inc.incorporados.length > 1) {
          console.log(
            `[webhook:${channel}] Recuperados ${inc.incorporados.length} mensajes de GHL ` +
              `(el webhook avisó de 1) | contact=${contactId}`
          );
        }
      } catch (e) {
        // GHL no contesta. Si el payload trae texto, se usa ese: perder un
        // mensaje es peor que arriesgar un duplicado, y el duplicado está
        // acotado — el barrido lo descarta por texto IDÉNTICO contra la marca
        // `textos_sin_id` que se deja aquí (descartarYaConocidos, E161).
        // Si no trae texto (una foto sola, un audio), no hay nada que procesar
        // todavía: el barrido la recupera en cuanto GHL vuelva a contestar.
        if (!messageText) throw e;
        console.warn(
          `[webhook:${channel}] GHL no contestó (${(e as Error).message}); se usa el texto del payload ` +
            `SIN deduplicar | contact=${contactId}`
        );
        textForClaude = messageText;
        await db.query(
          `INSERT INTO conversations (contact_id, phone, contact_name, messages, metadata, pending_message, pending_at)
           VALUES ($1, $2, $3, '[]'::jsonb,
                   jsonb_build_object('channel', $5::text, 'textos_sin_id',
                     jsonb_build_array(jsonb_build_object('texto', $4::text, 'at', now()))),
                   $4, now())
           ON CONFLICT (contact_id)
           DO UPDATE SET
             pending_message = CASE
               WHEN conversations.pending_message IS NULL OR conversations.pending_message = ''
                 THEN $4
               ELSE conversations.pending_message || E'\\n' || $4
             END,
             metadata = COALESCE(conversations.metadata, '{}'::jsonb)
                        || jsonb_build_object('channel', $5::text)
                        || jsonb_build_object('textos_sin_id',
                             COALESCE(conversations.metadata->'textos_sin_id', '[]'::jsonb)
                             || jsonb_build_array(jsonb_build_object('texto', $4::text, 'at', now()))),
             pending_at = now(),
             last_activity = now()`,
          [contactId, phone, contactName, textForClaude, channel]
        );
        await guardarGuard();
      }

      await enqueueMessage({ contactId, phone, contactName, message: textForClaude, channel });

      console.log(`[webhook:${channel}] Queued | contact=${contactId} msg="${textForClaude.slice(0, 50)}"${conMedia ? ' (con media)' : ''}`);
    } catch (err) {
      console.error(`[webhook:${channel}] Error processing:`, (err as Error).message);
      next(err);
    }
  };
}

webhookRouter.post('/ghl/whatsapp', makeGhlWebhookHandler('WhatsApp'));
webhookRouter.post('/ghl/facebook', makeGhlWebhookHandler('FB'));
webhookRouter.post('/ghl/instagram', makeGhlWebhookHandler('IG'));
// Compat: la ruta original equivale a WhatsApp (bots deployados antes del multicanal)
webhookRouter.post('/ghl', makeGhlWebhookHandler('WhatsApp'));
