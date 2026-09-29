import { db } from '../db/client';
import { conversacionesConInboundReciente } from '../services/ghl';
import {
  incorporarInboundNuevos,
  marcarComoYaIncorporados,
  marcarComoContestadoHasta,
  VENTANA_INCORPORACION_MS,
} from '../services/inbound';
import { enqueueMessage } from '../queue';
import { contactoBloqueadoAsync } from '../blocklist';

/**
 * Barrido de reconciliación — la mitad que el webhook no puede cubrir (E144).
 *
 * La red del webhook (`services/inbound.ts`) recupera una ráfaga entera a partir
 * de UN webhook que sí llegó. Pero si GHL no entrega NINGUNO —el único mensaje
 * de alguien que escribe una sola vez, o la ráfaga completa— del lado del bot no
 * se dispara nada y el cliente se queda sin respuesta, sin un solo error en los
 * logs. Esto pregunta al revés: cada minuto, quién escribió hace poco.
 *
 * Cuesta una llamada por minuto cuando no hay nada que hacer: la lista viene
 * ordenada por actividad y se corta en la primera conversación fuera de la
 * ventana. Solo las que tuvieron un entrante reciente pagan la segunda llamada.
 *
 * Portado de Viking Food vía bot-dra-mariana (29/09/2026).
 */

const INTERVALO_MS = 60 * 1000;

/** Tope de gasto por barrido, no límite del problema: lo que quede, lo toma el siguiente. */
const CONVERSACIONES_POR_BARRIDO = 25;

let corriendo = false;
let timer: NodeJS.Timeout | null = null;

/** Un barrido. Exportada para poder dispararla a mano. */
export async function barrer(): Promise<{ revisadas: number; recuperados: number }> {
  const desde = Date.now() - VENTANA_INCORPORACION_MS;
  const candidatos = await conversacionesConInboundReciente(desde, CONVERSACIONES_POR_BARRIDO);
  let recuperados = 0;

  for (const c of candidatos) {
    try {
      // Epazote tiene loop-guard y la plantilla de origen no. Un bot que el
      // webhook ya mandó a la lista negra NO se rescata aquí: sería contestarle
      // justo a la máquina que se cortó (el worker también lo descarta, pero
      // así no se gasta la llamada a GHL).
      if (await contactoBloqueadoAsync(c.contactId, c.phone)) continue;
      const inc = await incorporarInboundNuevos(c.contactId, {
        phone: c.phone,
        contactName: c.nombre,
      });
      if (inc.incorporados.length === 0) continue;

      recuperados += inc.incorporados.length;
      // Esto SIEMPRE es un mensaje que GHL nunca avisó: si el webhook hubiera
      // llegado, los ids ya estarían marcados. Por eso es WARN y dice cuántos —
      // es el número que hace visible algo que antes solo veía el cliente.
      console.warn(
        `[reconciliador] RECUPERADOS ${inc.incorporados.length} mensaje(s) que el webhook ` +
          `nunca entregó | contact=${c.contactId} canal=${inc.canal} ` +
          `texto="${inc.texto.replace(/\n/g, ' ⏎ ').slice(0, 80)}"`
      );

      await enqueueMessage({
        contactId: c.contactId,
        phone: c.phone ?? '',
        contactName: c.nombre,
        message: inc.texto,
        channel: inc.canal,
      });
    } catch (e) {
      // Un contacto que falla no cancela a los demás; el minuto siguiente reintenta.
      console.error(
        `[reconciliador] falló al reconciliar contact=${c.contactId}: ${(e as Error).message}`
      );
    }
  }

  return { revisadas: candidatos.length, recuperados };
}

/**
 * Primer arranque con la tabla vacía: marcar lo reciente como ya visto.
 *
 * Todo lo que llegó en los 10 minutos antes de este deploy lo contestó el
 * código viejo, que no marcaba nada. Sin esto, el primer barrido (o el primer
 * webhook de ese contacto) lo tomaría como nuevo y le volvería a contestar lo
 * que ya se le contestó. Se paga con no recuperar lo que GHL haya perdido
 * justo en esa ventana — que es como estaba antes de este cambio.
 *
 * Solo corre con la tabla vacía: una vez que hay filas, todo lo procesado ya
 * quedó marcado por la vía normal.
 */
export async function sembrarSiHaceFalta(): Promise<void> {
  const { rows } = await db.query('SELECT EXISTS (SELECT 1 FROM mensajes_incorporados) AS hay');
  if (rows[0]?.hay) return;

  // Mientras este servicio arranca, el viejo sigue recibiendo webhooks y
  // contestando sin marcar. Dos minutos cubren de sobra el relevo de Railway.
  marcarComoContestadoHasta(Date.now() + 2 * 60 * 1000);

  const desde = Date.now() - VENTANA_INCORPORACION_MS;
  const recientes = await conversacionesConInboundReciente(desde, CONVERSACIONES_POR_BARRIDO);
  let marcados = 0;
  for (const c of recientes) {
    marcados += await marcarComoYaIncorporados(c.contactId).catch(() => 0);
  }
  console.log(
    `[reconciliador] primer arranque: ${marcados} mensaje(s) reciente(s) de ${recientes.length} ` +
      'conversación(es) marcados como ya contestados'
  );
}

export async function startReconciliadorWorker(): Promise<void> {
  if (timer) return;

  try {
    await sembrarSiHaceFalta();
  } catch (e) {
    // Si GHL no contesta al arrancar, se arranca igual: el peor caso es
    // contestar dos veces algo de hace minutos, mejor que no barrer nunca.
    console.error(`[reconciliador] no se pudo sembrar al arrancar: ${(e as Error).message}`);
  }

  const tick = async () => {
    // Sin este candado, un barrido lento (GHL tardando) se solaparía con el
    // siguiente. El claim por id evita duplicados, pero duplicaría llamadas a
    // GHL justo cuando GHL ya anda mal.
    if (corriendo) {
      console.warn('[reconciliador] el barrido anterior no ha terminado; se salta este');
      return;
    }
    corriendo = true;
    try {
      const { revisadas, recuperados } = await barrer();
      // Solo se loguea cuando hubo algo: 1,440 líneas vacías al día esconden las que importan.
      if (recuperados > 0) {
        console.log(`[reconciliador] barrido: ${revisadas} revisada(s), ${recuperados} recuperado(s)`);
      }
    } catch (e) {
      console.error(`[reconciliador] barrido falló: ${(e as Error).message}`);
    } finally {
      corriendo = false;
    }
  };

  timer = setInterval(tick, INTERVALO_MS);
  timer.unref?.();
  console.log(`[reconciliador] barrido cada ${INTERVALO_MS / 1000}s`);
}

export function stopReconciliadorWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
