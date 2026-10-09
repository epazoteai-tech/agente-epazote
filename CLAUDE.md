# Bot Epazote — guía para trabajar en este repo

Bot de WhatsApp de **Restaurante Epazote** (Saltillo) sobre GoHighLevel + Claude, más la
**Mesa de Control** (panel del host y dashboard de campañas) que vive dentro del mismo
servicio. Nació de la plantilla `SKILLS/bot-ghl-template`, pero ya diverge bastante: los
cambios se hacen aquí, no en la plantilla.

Actualizado: 09/10/2026. Historial de decisiones y bloqueantes: `PENDIENTES.md`.

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
- Carga manual de escaladas viejas: `POST /api/mesa/reservas/escalada` con
  `{contact_id, nombre, fecha, hora, personas, ocasion, motivo}` (header `x-mesa-pin`).
- Cambiar el estado en el panel mueve la tarjeta de GHL (Confirmada / Asistió / No asistió).
- **Candado del PIN detrás de Cloudflare:** la llave del freno es `cf-connecting-ip`, pero
  solo si la petición viene de un rango de Cloudflare (si no, cualquiera la falsificaría por
  el dominio de Railway). Abrir la página sin PIN no cuenta como intento. Antes de esto, unas
  cuantas visitas bloqueaban a todo el equipo.
- Campañas: se atribuyen por palabra clave del mensaje con que abrió la conversación
  (cabrito, machacado, ceviche, durazno; gana la más específica). El gasto mensual se captura
  a mano en el panel.

## Meta Conversions API

- Purchase al cerrar la mesa con total, 10 min de espera, barredor cada 60 s, 5 intentos,
  `event_id` estable `epazote-consumo-{id}`.
- Con `ctwa_clid` (anuncio Click-to-WhatsApp, leído de `lastAttributionSource` del contacto
  en GHL) y `META_WABA_ID`, se intenta `business_messaging`; si Meta lo rechaza, se reenvía
  como `physical_store` por teléfono y se guarda el motivo en `consumos.capi_respuesta`.
- Pendiente: el token de CAPI no tiene permiso sobre la WABA ("(#200) You do not have
  permission"). Para leer o ligar el dataset de la WABA hace falta un token de usuario del
  sistema con `whatsapp_business_management`. `GET /api/mesa/meta/estado` diagnostica.

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

## Pendientes vivos (ver `PENDIENTES.md` para el detalle)

- Gustavo: facturación y bebidas de comidas y cenas.
- `BLOCKED_NUMBERS`: bot de Mercado Pago `+5215580035940` y números personales del equipo.
- Apagar el saludo automático de WhatsApp Business.
- Capturar el gasto mensual de las 4 campañas en el panel (están en $0, sin ROAS).
- Fase 2: foto del ticket con Vision (faltan 3–5 fotos reales).
- Aviso a Mony por plantilla `aviso_reserva_equipo`: falta elegir ruta (Workflow con
  notificación interna vs. el bot mandando la plantilla).
