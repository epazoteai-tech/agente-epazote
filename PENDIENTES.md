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

| # | Dato | Estado | Qué hace el bot mientras tanto |
|---|------|--------|--------------------------------|
| 1 | Horarios (L-J 8-23, V-S 8-24, D 8-20) | ✅ Confirmado por Gustavo 29/09 | Los usa |
| 2 | Fin del menú de desayunos | ✅ 2:00 pm (turnos del yaml y descripción) | |
| 3 | Formas de pago | ✅ Efectivo, tarjeta y transferencia (en el prompt) | Lo dice |
| 4 | Objeción más común | ✅ "A veces no contestan el teléfono" (guion nuevo en `<manejo_de_objeciones>`) | Ofrece el chat como el camino que sí contesta |
| 5 | Quién recibe el aviso de reservas del bot | ✅ **Mony** (decisión de Jorge 29/09; Gustavo confirma las de redes, pero el aviso va a Mony) | |
| 6 | Menú digital y rangos de precio | ⏳ Gustavo lo manda "en un ratito" | No da cifras |
| 7 | Estacionamiento / acceso a Parque Centro | ✅ 07/10/2026 | Edificio Maia (el de la postrería), por el interior de Parque Centro, enfrente de Matsuri. Estacionamiento: Parque Centro o el de Buffalo Wild Wings |
| 8 | Facturación | ⏳ Sin respuesta | Lo anota o escala |
| 9 | Mascotas, terraza, menú en inglés | ⏳ Sin respuesta | Lo anota |

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

## Recordatorio de reserva por plantilla (30/09/2026)

- ✅ Campo `reserva_fecha_dia` (tipo FECHA, id `qkpp0zGMFOfo6TOdPH2O`), lo llena el bot al registrar. `reserva_fecha` ahora es "sábado 3 de octubre".
- ✅ El prompt conoce la plantilla y sus botones ("Ahí estaremos" / "Necesito cambiarla").
- ⏳ Jorge: plantilla `recordatorio_reserva` (Utility, es_MX) aprobada por Meta + Workflow con trigger de fecha sobre `reserva_fecha_dia`, **filtrado a la etapa Confirmada**.
- ⏳ Probar con una reserva a varios días y mirar el reloj (E124): el recordatorio no debe salir al instante.

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

## Mesa de Control — fase 1 (30/09/2026)

Vive dentro del bot (patrón del KDS de Viking Food): `https://agente-epazote-production.up.railway.app/mesa/`, protegida con `MESA_PIN` (variable de Railway; sin ella la puerta queda cerrada para todos y el bot sigue funcionando).

- **Día:** reservas del día con Confirmar / Cancelar → Llegó / No llegó → Cerrar mesa (total a mano). Walk-in en dos toques (personas + cómo se enteró). Reserva por teléfono (entra confirmada). Corregir hora o personas.
- **Cada cambio de estado mueve la tarjeta en GHL** (Confirmada / Asistió / No asistió): Mony hace una sola acción y el recordatorio por plantilla, que cuelga de "Confirmada", funciona solo.
- **Próximas:** 14 días.
- **Resumen:** embudo, show rate (solo sobre reservas ya decididas), ticket por turno y por origen, ROAS por campaña (gasto mensual prorrateado), walk-ins por cómo se enteraron, CSV.
- **Campañas:** nombre + palabra clave del mensaje precargado del wa.link + gasto mensual. Gana la palabra clave más específica.
- Las reservas del bot entran solas (`guardarReservaDelBot`); un "CAMBIO de la solicitud anterior" corrige la misma fila.
- Probado: `pruebas/mesa.js` (20 casos puros), arnés contra Postgres real en PGlite (esquema 3 veces, candado y freno, flujo completo, dashboard, CSV: 29/29) y navegador en tamaño celular y escritorio.

### Fase 2 (pendiente)
- Foto del ticket → Claude Vision → total + platillos (columnas `foto_url`, `parse_json` ya existen). Antes: 3-5 fotos de tickets reales para probar si el parse es confiable.
- Evento **Purchase** a Meta por Conversions API al cerrar la mesa (columnas `capi_*` ya existen). Requisitos de configuración: ver abajo.

### Para el evento Purchase a Meta (configuración, lo hace Jorge)
1. **Dataset / Pixel ID de Epazote** en Events Manager (Business Manager de Epazote).
2. **Token de Conversions API** de ese dataset: Events Manager → dataset → Configuración → Conversions API → Generar token de acceso. Va a Railway como variable, nunca al repo.
3. **Acceso del Business Manager de la agencia** al dataset (o el token generado por el dueño).
4. **Código de evento de prueba** (Events Manager → Probar eventos) para la primera semana.
5. Confirmar con Gustavo el aviso de privacidad: se manda el teléfono **hasheado** (SHA-256) del cliente para que Meta lo empate.
6. Las campañas de wa.link no traen `ctwa_clid`, así que el empate es por teléfono (+ nombre) con `action_source: physical_store`. Si algún día corren anuncios Click-to-WhatsApp nativos, se puede atribuir por clic, que empata mucho mejor.
