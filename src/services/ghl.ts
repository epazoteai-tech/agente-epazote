/**
 * Cliente para Go High Level API v2 — single-tenant.
 * La API key se lee desde process.env.GHL_API_KEY a nivel de módulo.
 */

import type { GhlChannel } from '../types';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';

function getApiKey(): string {
  const key = process.env.GHL_API_KEY;
  if (!key) throw new Error('GHL_API_KEY is required');
  return key;
}

async function ghlFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  // Timeout de 10s para que un GHL lento no cuelgue el worker indefinidamente.
  const res = await fetch(`${GHL_API_BASE}${path}`, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(10_000),
    headers: {
      'Authorization': `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
      'Version': '2021-04-15',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GHL API error ${res.status} on ${path}: ${body}`);
  }

  return res.json();
}

/**
 * Envía un mensaje de texto al contacto via GHL Conversations API.
 *
 * El `channel` debe coincidir con el canal por donde vino el último mensaje
 * del cliente (WhatsApp, FB, IG, SMS, etc.). Si se equivoca, GHL lo rechaza
 * o lo manda al canal incorrecto.
 */
export async function sendMessage(
  contactId: string,
  message: string,
  channel: GhlChannel
): Promise<void> {
  await ghlFetch('/conversations/messages', {
    method: 'POST',
    body: JSON.stringify({
      type: channel,
      contactId,
      message,
    }),
  });
}

/**
 * Obtiene el contacto en GHL
 */
export async function getContact(
  contactId: string
): Promise<{ id: string; firstName: string; lastName: string; phone: string } | null> {
  try {
    const data = await ghlFetch(`/contacts/${contactId}`) as {
      contact: { id: string; firstName: string; lastName: string; phone: string };
    };
    return data.contact ?? null;
  } catch {
    return null;
  }
}

/**
 * Lee el último mensaje del contacto en GHL para extraer:
 *   - El canal real (WhatsApp / FB / IG / SMS / ...). El webhook NO trae el
 *     canal en string, por eso preguntamos a la API.
 *   - El attachment (si vino media — para que el webhook lo procese).
 *
 * Una sola llamada cubre ambas necesidades. El bot la invoca en cada webhook
 * entrante para detectar el canal por el que debe responder.
 */
export type AttachmentKind = 'image' | 'audio' | 'pdf' | 'other';

export interface LatestAttachment {
  url: string;
  kind: AttachmentKind;
  ext: string;
}

export interface LatestMessageInfo {
  channel: GhlChannel;
  attachment: LatestAttachment | null;
}

/**
 * Mapea el `messageType` inbound de GHL (string crudo de la API) al string
 * que espera el endpoint POST /conversations/messages.type.
 *
 * Si llega un tipo no reconocido (ej. canal nuevo de GHL), default a
 * WhatsApp con un warning — es el canal más usado y reduce el riesgo de
 * fallar el envío.
 */
function mapInboundTypeToChannel(rawType: string | undefined): GhlChannel {
  switch (rawType) {
    case 'TYPE_WHATSAPP':
      return 'WhatsApp';
    case 'TYPE_FB':
    case 'TYPE_FACEBOOK':
    case 'TYPE_FB_MESSENGER':
      return 'FB';
    case 'TYPE_IG':
    case 'TYPE_INSTAGRAM':
    case 'TYPE_INSTAGRAM_DIRECT_MESSAGE':
      return 'IG';
    case 'TYPE_SMS':
      return 'SMS';
    case 'TYPE_EMAIL':
      return 'Email';
    case 'TYPE_GMB':
      return 'GMB';
    case 'TYPE_LIVE_CHAT':
    case 'TYPE_WEBCHAT':
      return 'Live_Chat';
    case 'TYPE_CUSTOM_PROVIDER_SMS':
      return 'SMS';
    default:
      if (rawType) {
        console.warn(`[GHL] messageType desconocido "${rawType}" — usando WhatsApp como fallback`);
      }
      return 'WhatsApp';
  }
}

function attachmentFromUrl(url: string): LatestAttachment {
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase();
  let kind: AttachmentKind = 'other';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) kind = 'image';
  else if (ext === 'ogg' || ext === 'opus' || ext === 'mp3' || ext === 'm4a' || ext === 'wav') kind = 'audio';
  else if (ext === 'pdf') kind = 'pdf';
  return { url, kind, ext };
}

/** Mensaje tal como lo devuelve la Conversations API (solo lo que usamos). */
export interface GhlMessage {
  messageType?: string;
  direction?: string;
  body?: string;
  dateAdded?: string;
  attachments?: string[];
  userId?: string | null;
  meta?: { marketplace?: { appId?: string } } | null;
}

/**
 * Últimos mensajes de la conversación del contacto, del más nuevo al más
 * viejo. Incluye actividades internas (TYPE_ACTIVITY_*). LANZA si GHL falla:
 * cada caller decide si falla abierto o cerrado.
 */
export async function getConversationMessages(
  contactId: string,
  limit = 20
): Promise<GhlMessage[]> {
  const conv = await ghlFetch(`/conversations/search?contactId=${contactId}`) as {
    conversations?: Array<{ id: string }>;
  };
  const convId = conv.conversations?.[0]?.id;
  if (!convId) return [];
  const msgs = await ghlFetch(`/conversations/${convId}/messages?limit=${limit}`) as {
    messages?: { messages?: GhlMessage[] };
  };
  return msgs.messages?.messages ?? [];
}

export async function getLatestMessageInfo(
  contactId: string
): Promise<LatestMessageInfo | null> {
  try {
    // Pedimos varios mensajes porque GHL intercala en el feed:
    //   - Mensajes outbound (las respuestas del bot)
    //   - Actividades internas (TYPE_ACTIVITY_OPPORTUNITY al mover etapa,
    //     TYPE_ACTIVITY_CONTACT al editar contacto, etc.)
    // Necesitamos el último mensaje *inbound* del cliente con un
    // messageType de canal real, para no caer al fallback de WhatsApp y
    // responder por el canal incorrecto.
    const list = await getConversationMessages(contactId, 20);
    if (list.length === 0) return null;

    const lastInbound = list.find(
      (m) =>
        m.direction === 'inbound' &&
        typeof m.messageType === 'string' &&
        !m.messageType.startsWith('TYPE_ACTIVITY')
    );
    const target = lastInbound ?? list[0];

    const channel = mapInboundTypeToChannel(target.messageType);
    const url = target.attachments?.[0];
    const attachment = typeof url === 'string' && url ? attachmentFromUrl(url) : null;

    return { channel, attachment };
  } catch (err) {
    console.warn('[GHL] getLatestMessageInfo failed:', (err as Error).message);
    return null;
  }
}

/**
 * Descarga un archivo (típicamente media de GHL) y devuelve base64 + mime type
 * para pasarlo a Claude Vision como source.
 */
export async function fetchAsBase64(
  url: string
): Promise<{ base64: string; mimeType: string } | null> {
  // Las URLs de media de conversaciones (conversations-assets, dominios white-label
  // tipo links.<agencia>.mx) suelen ser links pre-firmados: mandarles un header
  // Authorization además de la firma en la URL provoca 403 en el storage. Por eso
  // probamos primero sin auth, y solo si falla reintentamos con el Bearer del PIT
  // (por si algún setup sí lo requiere).
  try {
    let res = await fetch(url);
    if (!res.ok) {
      const unauthedStatus = res.status;
      res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${getApiKey()}` },
      });
      if (!res.ok) {
        console.warn(
          `[GHL] fetchAsBase64 falló sin auth (${unauthedStatus}) y con auth (${res.status}) on ${url.slice(0, 80)}`
        );
        return null;
      }
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream';
    return { base64: buf.toString('base64'), mimeType };
  } catch (err) {
    console.warn('[GHL] fetchAsBase64 failed:', (err as Error).message);
    return null;
  }
}

/**
 * Actualiza el nombre del contacto en GHL a partir de un nombre completo.
 * Divide en firstName / lastName por el primer espacio.
 */
export async function updateContactName(
  contactId: string,
  nombreCompleto: string
): Promise<void> {
  const limpio = nombreCompleto.trim().replace(/\s+/g, ' ');
  if (!limpio) return;
  const partes = limpio.split(' ');
  const firstName = partes[0];
  const lastName = partes.slice(1).join(' ') || '';
  await ghlFetch(`/contacts/${contactId}`, {
    method: 'PUT',
    headers: { 'Version': '2023-02-21' },
    body: JSON.stringify({ firstName, lastName, name: limpio }),
  });
  console.log(`[GHL] Contact name updated: ${contactId} → ${firstName} ${lastName}`);
}

/**
 * Actualiza un campo personalizado del contacto en GHL.
 *
 * GHL espera `customFields: [{ id, field_value }]` en el PUT del contacto.
 * El value siempre se manda como string — GHL lo coerciona al tipo del
 * campo (número, fecha, etc.).
 */
export async function updateContactCustomField(
  contactId: string,
  fieldId: string,
  value: string
): Promise<void> {
  await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PUT',
    headers: { 'Version': '2023-02-21' },
    body: JSON.stringify({
      customFields: [{ id: fieldId, field_value: value }],
    }),
  });
  console.log(`[GHL] Custom field updated | contact=${contactId} field=${fieldId.slice(0, 8)}…`);
}

/**
 * Siembra los campos personalizados que el contacto todavía no tiene, con un
 * valor visualmente vacío (un espacio).
 *
 * Por qué hace falta: las plantillas y las notificaciones internas de GHL leen
 * estos campos como merge fields. Un campo que NUNCA se escribió no siempre
 * se renderiza vacío — según el contexto, GHL imprime el token literal
 * (`{{contact.colonia}}`) en el mensaje que recibe el equipo. Y como el bot
 * los va llenando conforme el contacto contesta, en la primera notificación
 * casi siempre falta alguno.
 *
 * Un string vacío NO sirve: GHL acepta el PUT con 200 pero no crea el campo
 * (verificado contra la API). Un espacio sí se guarda, y se ve como vacío.
 *
 * Solo escribe los que faltan, nunca pisa un valor real, y es best-effort: si
 * falla, se loguea y la conversación sigue.
 */
export async function seedCustomFields(
  contactId: string,
  fieldIds: string[]
): Promise<void> {
  if (fieldIds.length === 0) return;
  try {
    const data = (await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`)) as {
      contact?: { customFields?: Array<{ id: string; value?: unknown }> };
    };
    const yaTiene = new Set(
      (data.contact?.customFields ?? [])
        .filter((f) => f.value !== undefined && f.value !== null && String(f.value) !== '')
        .map((f) => f.id)
    );
    const faltantes = fieldIds.filter((id) => !yaTiene.has(id));
    if (faltantes.length === 0) return;

    await ghlFetch(`/contacts/${encodeURIComponent(contactId)}`, {
      method: 'PUT',
      headers: { 'Version': '2023-02-21' },
      body: JSON.stringify({
        customFields: faltantes.map((id) => ({ id, field_value: ' ' })),
      }),
    });
    console.log(`[GHL] Campos sembrados | contact=${contactId} n=${faltantes.length}`);
  } catch (err) {
    console.warn(`[GHL] seedCustomFields falló (no bloquea) | contact=${contactId}: ${(err as Error).message}`);
  }
}

/**
 * Crea una nota en el contacto
 */
export async function createNote(
  contactId: string,
  note: string
): Promise<void> {
  await ghlFetch(`/contacts/${contactId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body: note }),
  });
}

// ─── Pipelines y Opportunities ───────────────────────────────────────────────
// Estas funciones usan Version: 2023-02-21 (la requerida por Opportunities API).

const OPP_API_VERSION = '2023-02-21';

export interface PipelineStageInfo {
  id: string;
  name: string;
  position: number;
}

export interface PipelineInfo {
  id: string;
  name: string;
  stages: PipelineStageInfo[];
}

/**
 * Lista todos los pipelines de una location. Útil para el setup de Andrés —
 * no se usa en runtime del bot (las IDs se persisten en bot.config.yaml).
 */
export async function listPipelines(locationId: string): Promise<PipelineInfo[]> {
  const data = (await ghlFetch(
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    { headers: { 'Version': OPP_API_VERSION } }
  )) as { pipelines?: PipelineInfo[] };
  return data.pipelines ?? [];
}

export interface Opportunity {
  id: string;
  pipelineId: string;
  pipelineStageId: string;
  status: string;
  updatedAt?: string;
  createdAt?: string;
}

/**
 * Busca opportunities de un contacto dentro de un pipeline específico.
 *
 * GHL v2 expone /opportunities/search como GET con query params en
 * snake_case (`location_id`, `contact_id`, `pipeline_id`). Un POST con
 * body en camelCase devuelve 422 "property X should not exist".
 *
 * Devuelve [] si no hay (no lanza — los errores se loguean y se tratan como
 * "sin resultados" para que el caller decida qué hacer).
 */
export interface CreateOpportunityParams {
  contactId: string;
  pipelineId: string;
  pipelineStageId: string;
  locationId: string;
  /** Nombre de la tarjeta. Es lo único que el negocio ve en el pipeline:
   *  el nombre real del contacto o, si todavía no se sabe, su teléfono —
   *  nunca un literal, o todas las tarjetas terminan llamándose igual. */
  name: string;
}

/**
 * Crea una opportunity para un contacto que aún no tiene una en este
 * pipeline.
 *
 * Hace falta porque **GHL no crea opportunities solo porque el contacto
 * escriba por WhatsApp**: las crea un Workflow de entrada, y no todos los
 * contactos pasan por uno (ej. alguien que le escribe directo al número en
 * vez de venir de un anuncio). Sin esto, `mover_a_etapa` fallaba con
 * `no_opportunity` en cada intento y los reintentos disparaban la latencia de
 * la respuesta, con el contacto esperando.
 *
 * Ojo con la versión: este endpoint de creación funciona con
 * `2021-07-28`, distinta de la `2021-04-15` que usa el resto del servicio
 * (incluidos search y move de opportunities).
 */
export async function createOpportunity(
  params: CreateOpportunityParams
): Promise<Opportunity> {
  const data = (await ghlFetch('/opportunities/', {
    method: 'POST',
    headers: { 'Version': '2021-07-28' },
    body: JSON.stringify({
      pipelineId: params.pipelineId,
      locationId: params.locationId,
      contactId: params.contactId,
      pipelineStageId: params.pipelineStageId,
      name: params.name,
      status: 'open',
    }),
  })) as { opportunity: Opportunity };
  return data.opportunity;
}

export async function findContactOpportunity(
  contactId: string,
  pipelineId: string,
  locationId: string
): Promise<Opportunity[]> {
  try {
    const params = new URLSearchParams({
      location_id: locationId,
      contact_id: contactId,
      pipeline_id: pipelineId,
    });
    const data = (await ghlFetch(`/opportunities/search?${params.toString()}`, {
      method: 'GET',
      headers: { 'Version': OPP_API_VERSION },
    })) as { opportunities?: Opportunity[] };
    return data.opportunities ?? [];
  } catch (err) {
    console.warn(`[GHL] findContactOpportunity failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Mueve una opportunity a la etapa especificada. Lanza si la API falla
 * (el caller debe capturar y devolver un error string al modelo).
 */
export async function moveOpportunityToStage(
  opportunityId: string,
  pipelineStageId: string
): Promise<void> {
  await ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: 'PUT',
    headers: { 'Version': OPP_API_VERSION },
    body: JSON.stringify({ pipelineStageId }),
  });
}
