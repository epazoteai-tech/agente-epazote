# Bot Epazote — guía para trabajar en este repo

Bot de WhatsApp de **Restaurante Epazote** (Saltillo) sobre GoHighLevel + Claude, más la
**Mesa de Control** (panel del host y dashboard de campañas) que vive dentro del mismo
servicio. Nació de la plantilla `SKILLS/bot-ghl-template`, pero ya diverge bastante: los
cambios se hacen aquí, no en la plantilla.

Actualizado: 29/10/2026. Historial de decisiones y bloqueantes: `PENDIENTES.md`.

## Qué hace (y qué NUNCA hace)

- Toma reservas por WhatsApp **sin calendario**: junta nombre, fecha, hora, personas y
  ocasión con la tool `registrar_reserva` → custom fields + tag `reserva-solicitada` →
  el Workflow de GHL le avisa a **Mony**.
- **El bot NUNCA confirma una mesa.** La confirma una persona en el mismo chat. Hay red en
  código (`quitarConfirmacionDeMesa` en `src/services/reservas.ts`) que borra cualquier
  oración que confirme mesa o diga que hay lugar. No aflojarla.
- Escala a una persona (`escalar_a_humano`, tag `atencion-humana`, etapa "Atención
  humana"): grupos de 8+, eventos privados, facturación especial, prensa, quejas,
  cancelaciones, "ya llegué", quien pida una persona.
- Un solo seguimiento a las 3 h para reservas a medias, en ventana 10–21 h. Saluda de nuevo
  con el nombre y termina en UNA pregunta abierta de interés o de dudas ("Sigues con ganas de
  venir el sábado?"). Nunca da por hecho que ya reserva ("para cuántas te pongo la mesa?") ni
  agrega relleno después de la pregunta. Instrucción en `generateFollowUpMessage`
  (`src/services/claude.ts`); respaldo en `follow_ups.messages` del yaml.
- **Respuestas fijas que pidió Jorge** (todas en `configuracion/prompt.md`):
  - *Ubicación:* la frase del Edificio Maia y cierra con "Te gustaría que te cuente de los
    platillos, o buscabas venir en la mañana o en la tarde?", **no** ofreciendo la reserva
    (excepción anotada en `<regla_de_avance>`). Si contesta mañana/tarde, un platillo de la
    casa de ese turno + horario + "para qué día". Que el machacado "sale del comal" es cierto.
  - *Con quién dirigirse:* "Al llegar pregunta por Mónica. Si no está, dile a quien te
    reciba que hiciste tu reserva por WhatsApp."
  - *Ya tiene reserva:* contesta lo que pregunta, sin volver a registrar, sin revisar
    horario ni si la hora ya pasó, sin decir la hora actual y sin darla por confirmada.

## Dónde vive

| Qué | Dónde |
|---|---|
| Repo | GitHub `epazoteai-tech/agente-epazote` (cuenta del cliente, `epazoteai@gmail.com`) |
| Deploy | Railway, auto-deploy al hacer push a `main` |
| Dominio del panel y menús | `https://epazote.sellerstudio.mx` (Cloudflare con proxy → Railway) |
| Dominio de Railway | `agente-epazote-production.up.railway.app` (sigue vivo; los webhooks de GHL apuntan aquí, no moverlos) |
| Mesa de Control | `https://epazote.sellerstudio.mx/mesa` con `MESA_PIN` |
| Menús PDF | `public/menu/*.pdf`, públicos en `/menu/desayunos.pdf` y `/menu/comidas-y-cenas.pdf` |
| Salud | `GET /health` devuelve el sha desplegado |

## Reglas de trabajo

- **Push solo con `./subir-a-github.sh`** (lee `GITHUB_REPO`/`GITHUB_TOKEN` del `.env`; el
  token nunca queda en `.git/config`). Después, esperar a que `/health` devuelva el sha nuevo
  antes de decir que quedó.
- Commits con autor `Epazote <epazoteai@gmail.com>`:
  `git -c user.name=Epazote -c user.email=epazoteai@gmail.com commit ...`
- **Nunca imprimir secretos** (`.env`, PIN, tokens). Si Jorge necesita uno, va por `pbcopy`.
- El Railway CLI de esta Mac está logueado en la cuenta de **otro cliente**. No usarlo ni
  cambiarlo: las variables de Railway las pone Jorge en el dashboard.
- No mandar mensajes a clientes reales ni crear cosas en Meta (datasets, ligas) sin OK.
- Los datos del negocio viven en `configuracion/prompt.md` (`business_knowledge`) y en el
  yaml. Si un dato no está confirmado por Gustavo, no se inventa: el bot dice que no lo tiene
  y lo anota.

## Archivos clave

- `configuracion/bot.config.yaml` — pipeline "Reservas" (IDs de etapas), bloque
  `reservations:` (horario, turnos, menús, IDs de custom fields), follow-ups, escalación.
- `configuracion/prompt.md` — el cerebro. Sin `¿` ni `¡` (se quitan en código, E128).
- `src/workers/messageWorker.ts` — turno del bot, tools, guardias antes de enviar.
- `src/services/reservas.ts` — validación, guardias (`quitarConfirmacionDeMesa`,
  `quitarCalificativos`, `asegurarMenu`, `diceQueRegistro`).
- `src/services/mesa.ts` — filas de la Mesa (`guardarReservaDelBot`,
  `guardarReservaEscalada`, `guardarEscaladaEnMesa`, `datosParaLaMesa`), campañas, embudo.
- `src/routes/mesa.ts` — API del panel. `public/mesa/index.html` — el panel (SPA).
- `src/auth.ts` — candado del PIN con freno en Postgres (`mesa_intentos`).
- `src/services/capi.ts` — Purchase a Meta por Conversions API.
- `src/workers/followUpWorker.ts` + `generateFollowUpMessage` en `src/services/claude.ts`.

## Mesa de Control: decisiones que no son obvias

- **Resumen y Campañas cuentan por el día en que se PIDIÓ la reserva** (`created_at` en
  hora de Monterrey), no por el día de la mesa. Las reservas por anuncio casi siempre son para
  días después; contadas por `fecha` no aparecían.
- **Escaladas que son mesa** (`es_reserva=true` en `escalar_a_humano`) entran como
  `solicitada` con `escalada=true` y `motivo_escalacion`. Pueden venir sin fecha, hora o
  personas. Próximas las muestra arriba en "Atención humana · por confirmar" (todas, aunque
  sean para dentro de un mes) y no deja confirmar sin día, hora y personas. Una sola tarjeta
  por familia: una escalada sobre una solicitud viva la marca; un registro completo llena una
  escalada sin día.
- **Canal de cada reserva** (`reservas.canal`): `bot` (WhatsApp), `walk-in` y `telefono`
  (capturada a mano en la Mesa: confirmada al crearse, sin `contact_id`). Una reserva
  `telefono` no tiene conversación detrás. Atribución a campaña = palabra clave o texto del
  anuncio en el primer mensaje; quien vio el anuncio y escribió "hola" cuenta como bot.
- **No hay forma de borrar una reserva** desde la Mesa: solo cambiar estado (y eso mueve la
  tarjeta de GHL y la etiqueta). Los duplicados se borran en Railway → Postgres → Query. El
  `DATABASE_URL` del `.env` local es `localhost`, no producción.
- Carga manual de escaladas viejas: `POST /api/mesa/reservas/escalada` con
  `{contact_id, nombre, fecha, hora, personas, ocasion, motivo}` (header `x-mesa-pin`).
- Cambiar el estado en el panel mueve la tarjeta de GHL (Confirmada / Asistió / No asistió).
  También pone o quita la etiqueta `reserva-confirmada`, de la que cuelga el recordatorio por
  plantilla (cancelar no mueve la tarjeta: sin la etiqueta, el recordatorio le llegaba a quien canceló).
- **Candado del PIN detrás de Cloudflare:** la llave del freno es `cf-connecting-ip`, pero
  solo si la petición viene de un rango de Cloudflare (si no, cualquiera la falsificaría por
  el dominio de Railway). Abrir la página sin PIN no cuenta como intento. Antes de esto, unas
  cuantas visitas bloqueaban a todo el equipo.
- Campañas: se atribuyen por palabra clave del mensaje con que abrió la conversación
  (cabrito, machacado, ceviche, durazno; gana la más específica). El gasto mensual se captura
  a mano en el panel.

## Recordatorio de reserva (Workflow de GHL "RECORDATORIO RESERVA")

Lo arma Jorge en GHL; el código solo mantiene la etiqueta. Estado al 19/10/2026: en construcción.

1. **Disparador:** Custom date reminder → campo `reserva_fecha_dia` (tipo DATE, id
   `qkpp0zGMFOfo6TOdPH2O`) → **Before 1 día**, con **"Match on the year along with the day and
   month" marcado** (sin la casilla GHL lo repite cada año, como cumpleaños). NO `reserva_fecha`:
   es texto ("sábado 3 de octubre") y solo sirve como variable de la plantilla.
2. **Wait** hasta las 12:00 pm (el disparador no tiene hora).
3. **If/Else:** Contact Details → Tags → Includes → `reserva-confirmada`. Rama None vacía.
4. **Send WhatsApp Template** `recordatorio_reserva` (Utility, es_MX): {{1}} first_name,
   {{2}} `reserva_fecha`, {{3}} `reserva_hora`, {{4}} `reserva_personas`. Botones "Ahí estaremos" /
   "Necesito cambiarla": el texto tiene que coincidir con `configuracion/prompt.md` (`<mensajes_que_no_ves>`).
5. Allow re-entry encendido.

Por qué así y no con "Pipeline Stage Changed → Confirmada":
- Con el cambio de etapa + espera, una mesa confirmada hoy para mañana recibía el recordatorio
  al instante (E124). El disparador por fecha no tiene ese problema.
- Un Workflow que dispara por fecha arranca por CONTACTO: su If/Else **no ofrece condiciones de
  oportunidad** (pipeline/etapa). Por eso la condición es la etiqueta.
- **Quién mueve `reserva-confirmada`** (etiqueta creada en GHL, id `4oKeQNFe7ApEBwesnpOU`,
  commit `797892d`): la Mesa la pone al confirmar y la quita al cancelar, regresar a
  solicitada, llegó o no llegó (`sincronizarEtiqueta` en `src/routes/mesa.ts`,
  `accionEtiquetaConfirmada` en `src/services/mesa.ts`). El bot la quita en cada
  `registrar_reserva` (solicitud nueva o CAMBIO), así un cambio no recibe el recordatorio de la
  confirmación vieja.
- Hueco conocido: una tarjeta movida a "Confirmada" a mano en GHL (no desde la Mesa) no lleva
  etiqueta. Si pasa seguido: Workflow "Pipeline Stage Changed → Confirmada → Add tag".
- Si se confirma una mesa para mañana después de las 12:00, no recibe recordatorio (aceptado).

Probar antes de dar por bueno: reserva a 2–3 días en Confirmada (no debe salir al instante),
reserva para mañana (sale a las 12), cancelar en la Mesa (se quita la etiqueta), y tocar los dos
botones desde un teléfono de prueba (que la respuesta le llegue al bot como texto por el webhook).

## Meta Conversions API

- Purchase al cerrar la mesa con total, 10 min de espera, barredor cada 60 s, 5 intentos,
  `event_id` estable `epazote-consumo-{id}`.
- Con `ctwa_clid` (anuncio Click-to-WhatsApp, leído de `lastAttributionSource` del contacto
  en GHL) y `META_WABA_ID`, se intenta `business_messaging`; si Meta lo rechaza, se reenvía
  como `physical_store` por teléfono y se guarda el motivo en `consumos.capi_respuesta`.
- Pendiente: el token de CAPI no tiene permiso sobre la WABA ("(#200) You do not have
  permission"). Para leer o ligar el dataset de la WABA hace falta un token de usuario del
  sistema con `whatsapp_business_management`. `GET /api/mesa/meta/estado` diagnostica.

### Lo que Meta recibe de verdad (revisión del 14/10/2026)

Jorge creía que las campañas ya optimizaban para "los clientes que sí van". **No es así:**
- **Ninguna campaña usa el dataset.** Cuenta publicitaria "Epazote" (`1207618554190279`):
  los conjuntos activos optimizan por conversaciones iniciadas (Sellers - AI - Platillos, por
  WhatsApp; Astral - Cumpleaños), por clics o por alcance, y todos tienen `pixel_id` nulo. El
  Purchase sirve para medir, no para decidir a quién se le muestran los anuncios.
- **Casi no hay datos:** de 81 consumos cerrados desde septiembre, solo 3 se mandaron a Meta.
  Los otros 78 eran walk-ins sin teléfono (`capi_respuesta.omitido`). 0 por clic de anuncio.
- **El dataset de la cuenta, "Epazote Saltillo Event Data" (`2095461901251034`), no registra
  ningún evento en 28 días** (`server_last_fired_time` vacío). Revisar que `META_DATASET_ID`
  en Railway sea ese ID: los 3 Purchase pudieron irse a otro dataset. "Token y dataset aceptan
  eventos" en `/meta/estado` solo prueba la conexión, no que lleguen al dataset correcto.
- Con este volumen (3 compras, 9 reservas confirmadas en mes y medio) Meta no puede optimizar
  por compra: necesita ~50 por semana por conjunto. Dejar las campañas en conversaciones.

Orden propuesto: (1) capturar el WhatsApp de los walk-ins al cerrar la mesa — la palanca más
grande, encaja con las campañas de cumpleaños; (2) corregir `META_DATASET_ID` si no coincide;
(3) con 100+ teléfonos, público personalizado de los que van + lookalike + exclusión en
captación; (4) token con `whatsapp_business_management` para atribuir compras al clic del
anuncio Click-to-WhatsApp y, con volumen, optimizar por compra. Al 19/10/2026 Jorge no ha
pedido ninguna de estas; tampoco quiso el evento `Schedule` al confirmar.

## Costo de la API (cache)

Cambiado el 27/10/2026 (commit `4aefbb4`), en `src/services/claude.ts`:
- El system prompt (~10k tokens) lleva `CACHE_1H` (`ttl: '1h'`) en el turno y en el
  seguimiento. Con 5 min se volvía a pagar completo cada que el contacto tardaba en
  contestar; con 1 h además se comparte entre contactos. Es GA, sin header beta. El SDK 0.36
  no trae `ttl` en sus tipos: por eso el cast.
- `conCacheEnHistorial` pone un punto de 5 min en el último bloque de los mensajes, para que
  la vuelta después de una tool lea el historial del cache. Va **después** del de 1 h (la
  API exige 1 h antes que 5 min).
- Verificar en los logs de Railway: `cacheW` > 0 en la primera respuesta y `cacheR` > 0 en
  las siguientes dentro de la hora. Al 29/10 no se ha revisado.
- Siguientes palancas, sin hacer: recortar el menú escrito en el prompt (medir con
  `test:modelo`) y Haiku (descartado: violaciones al medir).

## Pruebas

- `npm test` — build + pruebas puras (reservas, mesa, capi, atención humana, guardias,
  candado, etc.). Debe terminar en "Todo bien" en cada bloque.
- `npm run test:modelo claude-sonnet-4-6` — conversaciones de `pruebas/conversaciones.js`
  contra el modelo real (~$0.75). Para un cambio puntual:
  `SOLO=grupo-grande,terraza npm run test:modelo claude-sonnet-4-6` (~$0.10). El resultado
  queda en `pruebas/.resultados/` y las llamadas a `escalar_a_humano` salen con sus datos.
  Cargar `.env` antes (`set -a; . ./.env; set +a`).
- Pruebas con Postgres real: PGlite + `pglite-socket` en el puerto 5544
  (`/tmp/claude-501/pglite/servidor.mjs`). Solo acepta **una conexión**: en arneses poner
  `db.options.max = 1`, si no, salen `ECONNRESET` falsos.
- Modelo en producción: `claude-sonnet-4-6` (Haiku tuvo violaciones menores al medir).
- `test:modelo` arma su propia llamada (`pruebas/medir-modelo.js`): prueba el prompt y las
  tools, **no** el `messages.create` de `claude.ts` (cache, guardias). Usa la
  `ANTHROPIC_API_KEY` del `.env` local, que tiene que ser la misma que la de Railway.
- Las conversaciones de prueba corren con la hora real: una que dice "hoy a las 2" de
  noche se comporta distinto que de día.

## Lecciones de este bot (además de las de la skill `errores-bot`)

- El saludo automático de WhatsApp Business (coexistencia) se guarda con la hora truncada al
  segundo, a veces ANTES del mensaje del cliente: la ventana para reconocerlo es simétrica
  (E174). Probar con timestamps crudos de la API, no inventados.
- Marcar la etapa de entrada como `AUTO:` mataba los seguimientos (E179).
- `\b` no funciona con acentos ("Menú"): usar límites explícitos (E178).
- Los calificativos ("de los favoritos", "una delicia") no se quitaron solo con el prompt;
  hay guardia en código.
- Cuando el bot debe decir un dato exacto (ubicación), darle la frase tal cual en el prompt;
  si no, adorna ("centro comercial").
- Si algo del panel "no aparece", revisar primero el filtro de fechas antes de culpar a la
  atribución.
- **Bot mudo con el servidor sano (27/10/2026):** `/health` respondía y los mensajes
  llegaban, pero cada turno fallaba con `401 invalid x-api-key` (la key de Anthropic dejó de
  servir; Jorge puso una nueva en Railway y en el `.env`). Si el bot no contesta, buscar
  `[claude] API error` en los logs antes de tocar código. Los mensajes quedan pendientes y
  se reintentan solos al arreglarlo.
- Pedirle al modelo que compare la hora de la reserva con la actual lo hace **narrar** su
  razonamiento en el chat ("Son las 10:51 pm… confirmo amablemente"). Mejor quitar la
  comparación que pedirle que no la diga.
- `quitarCalificativos` ya quita también ", uno de los favoritos…" sin verbo y la oración
  completa que opina del menú ("El menú nuevo está buenísimo."). Otra vez `\b` con acentos
  ("menú") no funcionó: límites explícitos (E178).

## Pendientes vivos (ver `PENDIENTES.md` para el detalle)

- Gustavo: facturación y bebidas de comidas y cenas.
- `BLOCKED_NUMBERS`: bot de Mercado Pago `+5215580035940` y números personales del equipo.
- Apagar el saludo automático de WhatsApp Business.
- Capturar el gasto mensual de las 4 campañas en el panel (están en $0, sin ROAS).
- Fase 2: foto del ticket con Vision (faltan 3–5 fotos reales).
- Aviso a Mony por plantilla `aviso_reserva_equipo`: falta elegir ruta (Workflow con
  notificación interna vs. el bot mandando la plantilla).
- Recordatorio de reserva: plantilla `recordatorio_reserva` aprobada por Meta y Workflow
  publicado y probado (ver la sección del recordatorio).
- Meta: revisar `META_DATASET_ID` en Railway contra `2095461901251034`, y decidir si se captura
  el teléfono de los walk-ins (ver "Lo que Meta recibe de verdad").
- Duplicados del bot en la Mesa (28/10/2026): Jorge iba a correr en Railway
  `DELETE FROM reservas WHERE id IN (14, 28, 200) AND canal = 'bot' AND total IS NULL;`
  (debe decir `DELETE 3`). Sin confirmar. Si se repite seguido: botón de borrar en la Mesa
  solo para reservas sin ticket.
- Revisar `cacheR`/`cacheW` en los logs (ver "Costo de la API").
- Por qué dejó de servir la API key el 27/10: si Anthropic la revocó por filtración, buscar
  dónde quedó expuesta.
