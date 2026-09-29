# Bot Epazote — pendientes antes de deployar

Estado al 25/09/2026. El código y la configuración están listos. Faltan datos
del negocio y el setup de GHL. Nada de esto se inventa: mientras no esté, el
prompt trae la salida segura ("ese dato no lo tengo confirmado, lo anoto para
el equipo").

## Decisiones ya tomadas (25/09/2026)

- Sin calendario. El bot registra solicitudes y el equipo confirma por el mismo chat.
- El bot se presenta como "la asistente digital de Epazote", sin nombre de persona.
- Grupos de 8 personas o más: se escalan, no se registran.
- Pipeline "Reservas": Solicitud recibida → Reserva registrada (bot) → Confirmada / Asistió / No asistió (equipo, a mano). Más "Atención humana" (bot, al escalar).
- Un solo follow-up, a las 3 horas, para reservas a medias. Nada de seguimiento de venta.
- Reservas hasta una hora antes del cierre (confirmado).
- La notificación de reservas le llega a **Mony**.
- Ya existe la cuenta de GHL de Epazote. **El WhatsApp de Epazote todavía NO está conectado** a esa subcuenta (bloqueante para probar y deployar).
- Mony tiene usuario en GHL: la notificación va como Internal Notification a su usuario.
- El bot guarda el origen de campaña (`reserva_origen`) y puede avisar a la Mesa de Control (`reservations.mesa_control_url`, apagado hasta que exista el endpoint).

## 🚨 Bloqueantes técnicos (auditoría errores-bot, 29/09/2026)

1. **La cuenta de Anthropic de Epazote NO TIENE CRÉDITO.** Es la misma llave que está en Railway: con WhatsApp conectado, el bot no le contestaría a nadie y `/health` seguiría en 200. Cargar saldo en console.anthropic.com → Plans & Billing. Después: `npm run test:modelo claude-sonnet-4-6 claude-haiku-4-5`.
2. ✅ **E144 (ráfagas perdidas) portado** el 29/09/2026 (commit a3d7f74): el texto sale de la API de GHL por tres puertas (webhook, inicio del turno, barrido cada minuto). Con loop-guard incluido. En logs: `[reconciliador] RECUPERADOS …` es un mensaje que GHL nunca avisó. Si la tabla `mensajes_incorporados` se queda vacía con tráfico, la deduplicación está apagada (E145).
3. **La plantilla `bot-ghl-template` tiene trabajo sin commitear de otra sesión** (`verificar-llaves.ts`, `index.ts`). Cuando esa sesión cierre, subirle el chequeo de crédito (ver nota nueva en E156).

## Datos del negocio por confirmar (Jorge / Gustavo)

| # | Dato | Dónde se cambia | Qué hace el bot mientras tanto |
|---|------|-----------------|--------------------------------|
| 1 | Horarios vigentes (L-J 8-23, V-S 8-24, D 8-20) | `bot.config.yaml` → `business.description` y `reservations.horario`, y `<business_knowledge>` | Usa esos |
| 2 | A qué hora termina el menú de desayunos (propuesta: 1 pm; Jorge lo pregunta) | `reservations.turnos` | Solo afecta la etiqueta del resumen |
| 4 | ¿En qué horario confirma Mony las reservas y quién la cubre de noche? | Workflow de GHL + `<flujo_de_cierre>` | De noche dice "en cuanto el equipo esté de vuelta" |
| 5 | Menú digital (link o PDF) | `<business_knowledge>` | Dice que no lo tiene a la mano |
| 6 | Rangos de precio que el bot puede decir | `<business_knowledge>` + objeción "se ve caro" | No da cifras |
| 7 | Facturación | `<business_knowledge>` | Lo anota o escala |
| 8 | Menú en inglés | `<business_knowledge>` | Lo anota |
| 9 | Mascotas y terraza | `<business_knowledge>` | Lo anota |
| 10 | Métodos de pago | `<business_knowledge>` | Lo anota |
| 11 | Acceso y estacionamiento en Parque Centro | `<business_knowledge>` | Solo da la dirección |
| 12 | Objeciones que de verdad escuchan (validar las 4 de la estrategia y ampliar) | `<manejo_de_objeciones>` | Usa las 4 de la estrategia |

## Setup en GHL (subcuenta Epazote)

**Requisito #1: la subcuenta de Epazote existe y su WhatsApp está conectado.** Sin número conectado no hay bot. ⏳ Subcuenta lista; WhatsApp sin conectar (29/09/2026).

Deploy: ✅ Railway `agente-epazote-production.up.railway.app`, `/health` OK con commit aa38197, webhook valida el secreto (401 sin él, 200 con él).

1. ✅ PIT y Location ID en `.env` (28/09/2026).
2. ✅ Custom fields creados por API: `reserva_fecha`, `reserva_hora`, `reserva_personas`, `reserva_ocasion`, `reserva_resumen`, `reserva_origen` (IDs ya en el yaml).
3. ✅ Tags creados: `reserva-solicitada`, `atencion-humana`.
4. ✅ Pipeline "Reservas" con las 6 etapas creado por API (IDs ya en el yaml).
5. ✅ Prueba de humo con el código real contra GHL: nombre, 6 campos, tag, nota, crear y mover oportunidad, leer conversaciones. Todo OK (la búsqueda de oportunidades tarda ~2 s en indexar, sin impacto).
6. ✅ Workflow de entrada: primer mensaje del contacto → crear opportunity en "Solicitud recibida". (Si falta, el bot crea la tarjeta él mismo al registrar la reserva, pero el follow-up de reservas a medias no puede verificar la etapa.)
7. ✅ Workflow de webhook: "Customer Replied" (solo inbound, WhatsApp) → POST a `https://agente-epazote-production.up.railway.app/webhook/ghl/whatsapp` con header `x-webhook-secret`.
8. ✅ Workflow de notificación a **Mony**: trigger "Tag Added: reserva-solicitada" → Internal Notification a su usuario de GHL (activar notificaciones de la app móvil de GHL en su teléfono) con `{{contact.reserva_resumen}}`, `{{contact.reserva_origen}}` y el teléfono del contacto. Nunca SMS al contacto.
9. ✅ Workflow de escalación (recomendado): trigger "Tag Added: atencion-humana" → notificación interna con la última nota del contacto.

## Pruebas antes de entregar (Paso 4 adaptado)

- `npm test`: incluye `pruebas/reservas.js` (validación de horario, grupo grande, resumen).
- Solicitud completa por WhatsApp → revisar en GHL: los 5 custom fields llenos, tag `reserva-solicitada`, nota "[SOLICITUD DE RESERVA]", tarjeta en "Reserva registrada", y **leer con tus ojos la notificación que le llegó al equipo** (merge field sin vacíos).
- En logs: `[tool:registrar_reserva] OK | ... resumen="..."`.
- Segunda reserva del mismo contacto → la notificación vuelve a llegar (el tag se repone).
- Reserva a medias → a las 3h `[follow-up] programado`, y el mensaje sale.
- Reserva completa → `[follow-up] no programado (conversación cerrada)`.
- Grupo de 10 → escala, no registra.
- Alguien del equipo contesta a mano en GHL → el bot se calla 2 horas en esa conversación.
- `npm run test:modelo claude-sonnet-4-6 claude-haiku-4-5` con `pruebas/conversaciones.js` (~$1-3 USD). Revisar sobre todo que ningún turno confirme la mesa.

## Auditoría errores-bot (29/09/2026): qué se revisó y qué se arregló

Arreglado en código (con pruebas en `pruebas/reservas.js`, 93/93 en verde con `TZ=UTC`):
- **Red contra confirmar la mesa**: antes de enviar, se quita toda oración que confirme mesa o diga que hay lugar ("tu mesa está confirmada", "sí hay lugar", "está disponible", "te esperamos") y se pone "Eso te lo confirma el equipo en un momento por aquí mismo." Conserva la pregunta que venga después. Log: `[reservas] se quitó una confirmación de mesa`.
- **"Ya registré tu solicitud" sin registro** (forma de E143): se escala en código para que Mony tome los datos. Log: `[reservas] dijo que registró sin registrar`.
- **Registro duplicado** (E60): la misma solicitud en menos de 30 min no vuelve a notificar a Mony.
- **"Ya les avisé" en plural** no lo detectaba la red de E66. Ya sí.
- **Chequeo de crédito al arrancar** (E156): `/v1/models` pasaba con saldo cero.
- **Origen de campaña** usa el mismo hueco de sesión que el historial (48 h), no uno propio.
- **Horario** ya no está tecleado en el prompt (E68): el prompt remite a `business.description`.
- **Ejemplo con fecha fija** ("sábado 26 de septiembre") quitado (E16).

Revisado y bien: tag de notificación repuesto (E151), presentación como asistente digital en código (E141/E107), ¿¡ quitados en código (E128), zona America/Monterrey (E13), tools vs dispatch (E149), sin llamadas a tools desde código con parámetros mal escritos (E157), cola con aviso y barredor (E150), historial por sesión (E83), bot callado 2 h cuando escribe una persona (E85/E134), follow-up con corte humano (E89), `cerrar_seguimiento` (E137), `/health` con sha (E74), token fuera de `.git/config` (E116), el filtro anti-narración deja pasar las frases literales del prompt (E131), y el guion de cierre no dispara la red de handoff.

## Contrato con la Mesa de Control

Cuando `reservations.mesa_control_url` está en el yaml, cada solicitud registrada manda:

```
POST <mesa_control_url>
x-webhook-secret: <MESA_CONTROL_SECRET>
{ contacto_ghl_id, nombre, telefono, fecha: "YYYY-MM-DD", hora: "HH:MM", personas, ocasion,
  turno, origen_mensaje, canal: "bot", resumen, registrada_at }
```

Es best-effort: si falla, la reserva queda en GHL igual y el log dice `[mesa-control] POST falló`. Un cambio de reserva llega como un POST nuevo con "CAMBIO de la solicitud anterior" al inicio de `ocasion`, así que la Mesa tiene que tratarlo como actualización por `contacto_ghl_id`, no como reserva nueva. La confirmación, la llegada y las cancelaciones no pasan por el bot.

## Cambios de código respecto a la plantilla

- Nuevo bloque `reservations:` en el yaml y tool `registrar_reserva` (`src/services/reservas.ts`, `handleRegistrarReserva` en `messageWorker.ts`). Candidato a subir a `SKILLS/bot-ghl-template/` si se repite en otro restaurante.
- `mensajeDeOrigen`: primer mensaje de la sesión como origen de campaña, más el POST opcional a la Mesa de Control.
- Una solicitud registrada en las últimas 24h cuenta como conversación cerrada para los follow-ups.
- `pruebas/medir-modelo.js` responde `registrar_reserva` con la validación real y le pasa la fecha de hoy al modelo.
