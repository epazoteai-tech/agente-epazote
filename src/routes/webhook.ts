import { Router, Request, Response, NextFunction } from 'express';
import { enqueueMessage } from '../queue';
import { db } from '../db/client';
import { GHLWebhookPayload, GhlChannel } from '../types';
import { getLatestMessageInfo } from '../services/ghl';
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

      // GHL no manda la URL del adjunto en el webhook — hay que pedirla a la
      // conversations API. OJO: un mensaje de WhatsApp puede traer TEXTO Y
      // media juntos (ej. una foto con un comentario) — por eso esto se
      // consulta SIEMPRE, no solo cuando message.body viene vacío. Antes solo
      // se checaba si el body venía vacío, así que cualquier imagen/audio
      // mandado junto con texto se ignoraba por completo (bug encontrado
      // 2026-08-12 con un caso real: contacto mandó una foto con la frase
      // "conseguí el dinero pero en efectivo" y la foto nunca se procesó).
      let attachmentUrl: string | null = null;
      let attachmentKind: string | null = null;
      let textForClaude = messageText;

      const info = await getLatestMessageInfo(contactId);
      const att = info?.attachment;
      if (att) {
        attachmentUrl = att.url;
        attachmentKind = att.kind;
        console.log(`[webhook:${channel}] Media detectada | contact=${contactId} kind=${att.kind} ext=${att.ext}`);

        const placeholder =
          att.kind === 'image' ? '[el contacto envió una imagen]'
          : att.kind === 'pdf' ? '[el contacto envió un PDF]'
          : att.kind === 'audio' ? '[el contacto envió un audio]'
          : '[el contacto envió un archivo]';
        textForClaude = textForClaude ? `${textForClaude}\n${placeholder}` : placeholder;
      }

      if (!textForClaude) {
        console.log(`[webhook:${channel}] Skipped — sin texto ni attachment | contact=${contactId}`);
        return;
      }

      // Upsert con concatenación del pending_message + append a pending_attachments.
      // Persistimos el canal en metadata.channel para auditoría y para que el
      // worker de follow-ups sepa por dónde responder.
      await db.query(
        `INSERT INTO conversations (contact_id, phone, contact_name, messages, metadata, pending_message, pending_at, pending_attachments, turn_count, fast_replies, fast_reply_marker)
         VALUES ($1, $2, $3, '[]'::jsonb, jsonb_build_object('channel', $6::text), $4, now(), COALESCE($5::jsonb, '[]'::jsonb), $7, $8, $9)
         ON CONFLICT (contact_id)
         DO UPDATE SET
           turn_count = $7,
           fast_replies = $8,
           fast_reply_marker = $9,
           pending_message = CASE
             WHEN conversations.pending_message IS NULL OR conversations.pending_message = ''
               THEN $4
             ELSE conversations.pending_message || E'\n' || $4
           END,
           pending_attachments = COALESCE(conversations.pending_attachments, '[]'::jsonb) || COALESCE($5::jsonb, '[]'::jsonb),
           metadata = COALESCE(conversations.metadata, '{}'::jsonb) || jsonb_build_object('channel', $6::text),
           pending_at = now(),
           last_activity = now()`,
        [
          contactId,
          phone,
          contactName,
          textForClaude,
          attachmentUrl ? JSON.stringify([{ url: attachmentUrl, kind: attachmentKind }]) : null,
          channel,
          guard.turnCount,
          guard.fastReplies,
          guard.fastReplyMarker,
        ]
      );

      await enqueueMessage({ contactId, phone, contactName, message: textForClaude, channel });

      console.log(`[webhook:${channel}] Queued | contact=${contactId} msg="${textForClaude.slice(0, 50)}"${attachmentUrl ? ' (con media)' : ''}`);
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
