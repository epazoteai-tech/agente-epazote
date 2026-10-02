/**
 * Verificación de credenciales CONTRA EL PROVEEDOR al arrancar.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ EXISTE
 * ---------------------------------------------------------------------------
 * `warnIfApiKeysLookSwapped` (src/env.ts) mira la FORMA de las llaves: que la
 * de Anthropic empiece con `sk-ant-`, que la de OpenAI no sea una de Anthropic.
 * Eso atrapa una llave pegada en la variable equivocada y nada más.
 *
 * Una llave con la forma correcta pero REVOCADA pasa ese filtro sin una queja,
 * y el bot arranca viéndose perfectamente sano: `/health` en 200, el webhook
 * rechazando bien sin secreto, los deploys en verde. Del 20 al 22 de septiembre
 * de 2026 el bot de Mr. Jack estuvo así, sin contestarle a NADIE, con dos
 * llaves muertas en Railway. Dos leads de pauta escribieron el domingo pidiendo
 * cotización y nunca supieron que del otro lado no había nadie.
 *
 * El síntoma solo existía en los Deploy Logs, y solo si alguien iba a buscarlo.
 * Esta función lo pone en la primera pantalla del arranque.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO LANZA
 * ---------------------------------------------------------------------------
 * Podría tirar el proceso y forzar la corrección. No lo hace, por dos razones:
 *
 *   1. Un tropiezo de red al arrancar no es una llave mala. Tirar el proceso
 *      por un timeout de un proveedor deja al negocio sin WhatsApp por algo
 *      que se iba a curar solo.
 *   2. Con `restartPolicyMaxRetries` de por medio, fallar al arrancar de forma
 *      repetida deja el servicio MUERTO, sin `/health` y sin logs nuevos — o
 *      sea, más difícil de diagnosticar, no menos.
 *
 * Falla RUIDOSO, no caído: el bot sigue en pie y el problema queda escrito con
 * todas sus letras.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ NO BLOQUEA EL ARRANQUE
 * ---------------------------------------------------------------------------
 * Corre DESPUÉS de `app.listen` y sin `await`. El healthcheck de Railway tiene
 * 30 segundos; encadenar tres llamadas de red antes de escuchar el puerto es
 * meterle riesgo al arranque para ganar nada.
 */

import { verificarMeta } from './services/capi';
import { getConfig } from './config';

/** Ninguna verificación puede colgar el arranque más que esto. */
const TIMEOUT_MS = 8_000;

type Resultado = { ok: boolean; detalle: string };

async function verificarAnthropic(): Promise<Resultado> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key?.trim()) {
    return { ok: false, detalle: key === undefined ? 'falta ANTHROPIC_API_KEY' : 'ANTHROPIC_API_KEY está vacía' };
  }

  // `/v1/models` valida la credencial sin gastar un solo token.
  const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { ok: false, detalle: `HTTP ${res.status} — ${(await res.text()).slice(0, 200)}` };

  // `/v1/models` responde 200 aunque la cuenta NO TENGA CRÉDITO: la llave es
  // válida y el bot no puede contestarle a nadie. Pasó con Epazote (29/09/2026):
  // la batería de medición falló con "credit balance is too low" y este mismo
  // chequeo lo habría dado por bueno. Una generación de 1 token lo prueba de
  // verdad (una fracción de centavo por arranque).
  const gen = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (gen.ok) return { ok: true, detalle: 'credencial válida y con crédito' };
  const cuerpo = (await gen.text()).slice(0, 200);
  if (/credit balance/i.test(cuerpo)) {
    return { ok: false, detalle: 'la cuenta de Anthropic NO TIENE CRÉDITO (Plans & Billing), el bot no puede contestar' };
  }
  return { ok: false, detalle: `generación de prueba falló: HTTP ${gen.status} — ${cuerpo}` };
}

async function verificarOpenAI(): Promise<Resultado | null> {
  const key = process.env.OPENAI_API_KEY;

  // Es opcional: hay bots sin audio. Pero hay que separar dos casos que un
  // `if (!key)` mete en el mismo saco, y solo uno es inocente:
  //
  //   - la variable NO EXISTE  → este bot no transcribe audio, no hay nada que
  //                              verificar ni nada que reportar.
  //   - la variable existe VACÍA → alguien la borró o la pegó mal. Saltarla en
  //                              silencio es exactamente la falla que este
  //                              módulo viene a matar: el bot recibiría notas
  //                              de voz y contestaría como si no existieran.
  //
  // Se encontró probando este mismo archivo: con `OPENAI_API_KEY=""` en el
  // entorno, la verificación desaparecía del arranque sin dejar rastro.
  if (key === undefined) return null;
  if (key.trim() === '') {
    return { ok: false, detalle: 'la variable existe pero está VACÍA — las notas de voz no se van a transcribir' };
  }

  const res = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { ok: true, detalle: 'credencial válida' };
  return { ok: false, detalle: `HTTP ${res.status} — ${(await res.text()).slice(0, 200)}` };
}

/**
 * GHL se verifica con UNA llamada que cubre las tres cosas que pueden estar
 * mal, porque en la práctica se confunden entre sí:
 *
 *   - la llave (401 "Invalid Private Integration token")
 *   - la LOCATION (403 "The token does not have access to this location")
 *   - los scopes del token sobre oportunidades
 *
 * Y de paso compara el pipeline y las etapas del yaml contra lo que GHL tiene
 * de verdad. `validateConfig` ya cruza las etapas contra el propio yaml, pero
 * eso solo prueba que el archivo es coherente consigo mismo: si alguien
 * renombra o borra una etapa DENTRO del CRM, el yaml sigue impecable y el bot
 * deja de mover tarjetas sin un solo error (E17 de la skill `errores-bot`).
 *
 * El caso que motivó esto: con la location equivocada, buscar oportunidades
 * devolvía 403 y crearlas devolvía `404 "Pipeline not found"` sobre un pipeline
 * que SÍ existía. Ninguno de los dos mensajes nombra a `GHL_LOCATION_ID`.
 */
async function verificarGHL(): Promise<Resultado> {
  const key = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!key?.trim()) {
    return { ok: false, detalle: key === undefined ? 'falta GHL_API_KEY' : 'GHL_API_KEY está vacía' };
  }
  if (!locationId?.trim()) {
    return { ok: false, detalle: locationId === undefined ? 'falta GHL_LOCATION_ID' : 'GHL_LOCATION_ID está vacía' };
  }

  const res = await fetch(
    `https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        Version: '2021-07-28',
        // Sin User-Agent, Cloudflare rechaza con 403 `browser_signature_banned`
        // antes de mirar el token (E20). Parecería falta de permisos y no lo es.
        'User-Agent': 'bot-ghl/1.0',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    const pista =
      res.status === 403
        ? ` → revisa GHL_LOCATION_ID (hoy: "${locationId}"), no la llave: este 403 es de LOCATION`
        : res.status === 401
          ? ' → la llave está revocada o es de otra subcuenta'
          : '';
    return { ok: false, detalle: `HTTP ${res.status} — ${body}${pista}` };
  }

  const cfg = getConfig();
  if (!cfg.pipeline) return { ok: true, detalle: 'credencial y location válidas' };

  const { pipelines = [] } = (await res.json()) as {
    pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string }> }>;
  };

  const pipeline = pipelines.find((p) => p.id === cfg.pipeline!.id);
  if (!pipeline) {
    return {
      ok: false,
      detalle:
        `el pipeline "${cfg.pipeline.name}" (${cfg.pipeline.id}) del yaml NO existe en la ` +
        `location ${locationId}. Los que sí hay: ${pipelines.map((p) => `${p.name} (${p.id})`).join(', ') || 'ninguno'}`,
    };
  }

  const idsReales = new Set((pipeline.stages ?? []).map((s) => s.id));
  const huerfanas = cfg.pipeline.stages.filter((s) => !idsReales.has(s.id));
  if (huerfanas.length > 0) {
    return {
      ok: false,
      detalle:
        `el pipeline existe, pero estas etapas del yaml ya no están en GHL: ` +
        huerfanas.map((s) => `"${s.name}" (${s.id})`).join(', ') +
        '. El bot no va a poder moverlas y no habrá error en los logs.',
    };
  }

  return {
    ok: true,
    detalle: `credencial, location y pipeline "${pipeline.name}" con sus ${cfg.pipeline.stages.length} etapas`,
  };
}

/**
 * Corre las tres verificaciones en paralelo y las deja escritas en el arranque.
 *
 * Nunca lanza: cualquier excepción (timeout, DNS, proveedor caído) se reporta
 * como fallo de esa verificación y las demás siguen su curso.
 */
export async function verificarLlaves(): Promise<void> {
  const [anthropic, openai, ghl, meta] = await Promise.all([
    verificarAnthropic().catch((e: Error) => ({ ok: false, detalle: `no se pudo verificar: ${e.message}` })),
    verificarOpenAI().catch((e: Error) => ({ ok: false, detalle: `no se pudo verificar: ${e.message}` })),
    verificarGHL().catch((e: Error) => ({ ok: false, detalle: `no se pudo verificar: ${e.message}` })),
    verificarMeta().catch((e: Error) => ({ ok: false, detalle: `no se pudo verificar: ${e.message}` })),
  ]);

  // `critico` separa lo que deja al bot MUDO de lo que solo le quita una
  // capacidad. Importa para el cierre del banner: un aviso que exagera se
  // vuelve ruido, y el siguiente que sí era grave ya nadie lo lee.
  const chequeos: Array<[string, Resultado | null, boolean]> = [
    ['Anthropic (el bot no puede pensar sin esto)', anthropic, true],
    ['OpenAI / Whisper (las notas de voz)', openai, false],
    ['GoHighLevel (leer y responder, y mover el pipeline)', ghl, true],
    ['Meta Conversions API (el Purchase de la Mesa de Control)', meta, false],
  ];

  const rotos = chequeos.filter(([, r]) => r && !r.ok) as Array<[string, Resultado, boolean]>;
  const hayCritico = rotos.some(([, , critico]) => critico);

  for (const [nombre, r] of chequeos) {
    if (!r) continue;
    if (r.ok) console.log(`[llaves] ✅ ${nombre}: ${r.detalle}`);
  }

  if (rotos.length === 0) {
    console.log('[llaves] Todas las credenciales verificadas contra su proveedor.');
    return;
  }

  // Un bloque, no tres renglones sueltos: esto tiene que saltar a la vista de
  // quien abra los logs sin estar buscándolo.
  console.error('');
  console.error('='.repeat(78));
  console.error(
    hayCritico
      ? '[llaves] ⛔  EL BOT ESTÁ ARRIBA PERO NO VA A CONTESTARLE A NADIE'
      : '[llaves] ⚠️   EL BOT CONTESTA, PERO LE FALTA UNA CAPACIDAD'
  );
  console.error('='.repeat(78));
  for (const [nombre, r] of rotos) {
    console.error(`  ✖ ${nombre}`);
    console.error(`    ${r.detalle}`);
  }
  console.error('');
  console.error('  Estas credenciales viven en las Variables del servicio, NO en el código:');
  console.error('  un redeploy no las arregla.');
  if (hayCritico) {
    console.error('  /health va a seguir en 200 y el webhook va a seguir aceptando mensajes.');
    console.error('  Por fuera nada se ve roto. Este bloque es el único aviso que hay.');
  }
  console.error('='.repeat(78));
  console.error('');
}
