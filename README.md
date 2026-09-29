# Bot GHL — plantilla propia de Sellers Studio

Bot de WhatsApp conectado a Go High Level (GHL), construido sobre Claude.

> Generado con la skill propia `crear-bot-ghl` — ver
> `/Users/jorgecortes/Documents/AI/SKILLS/crear-bot-ghl-SKILL.md` para el
> paso a paso completo de cómo usar esta plantilla con un cliente nuevo.

## Qué hace

- Recibe mensajes de WhatsApp (y opcionalmente Facebook/Instagram) via webhook de GHL.
- Acumula mensajes en ráfaga con debounce configurable, para que el bot procese todo junto y no responda varias veces seguidas.
- Transcribe audios automáticamente (Whisper).
- Procesa imágenes y PDFs (Claude Vision).
- Consulta disponibilidad y agenda citas en GHL (opcional).
- Mueve contactos entre etapas de un pipeline de GHL (opcional).
- Escala a un humano con tag + nota cuando hace falta (opcional).
- Guarda datos de la conversación en campos personalizados (opcional).
- Manda follow-ups automáticos generados con IA (con contexto real de la conversación) cuando un lead deja de responder (opcional).
- Mantiene historial de la conversación en PostgreSQL.
- Corta solo las conversaciones con otros bots: si del otro lado detecta una máquina (cadencia de respuesta imposible o una ráfaga de turnos sin pausa), manda ese contacto a una lista negra permanente y lo ignora en silencio, para no pagar tokens de un chat que no es una persona.

## Cómo cambiar el comportamiento del bot

**No necesitas tocar código.** Toda la configuración del bot vive en la carpeta `configuracion/`:

| Archivo | Qué controla |
|---|---|
| `configuracion/bot.config.yaml` | Nombre, negocio, tono, idioma, debounce, modelo de Claude, pipeline, calendarios, follow-ups, escalación, campos personalizados |
| `configuracion/prompt.md` | El "cerebro" del bot — su prompt en markdown editable |

Después de editar:

```bash
git add .
git commit -m "ajuste de configuración"
git push
```

Railway redeploya solo en ~30 segundos.

## Cómo correrlo localmente

1. Copia `.env.example` a `.env` y llena las variables.
2. Levanta Postgres local: `docker compose up -d`.
3. Instala dependencias: `npm install`.
4. Corre las migraciones: `npm run migrate:dev`.
5. Inicia el bot: `npm run dev`.

El servidor escucha en `http://localhost:3000`. El healthcheck es `GET /health`.

## Cómo deployar

El proyecto usa Railway con auto-deploy desde GitHub:

1. Cualquier `git push` a la branch principal redeploya automáticamente.
2. Las credenciales (API keys, tokens) viven en variables de entorno de Railway, NO en este repo.
3. Apunta el/los webhook(s) de GHL a:

```
https://<tu-app>.up.railway.app/webhook/ghl/whatsapp
https://<tu-app>.up.railway.app/webhook/ghl/facebook   (si aplica)
https://<tu-app>.up.railway.app/webhook/ghl/instagram  (si aplica)
```

Pasos completos de deploy y setup de GHL en `crear-bot-ghl-SKILL.md`.

## Estructura del proyecto

```
configuracion/
├── bot.config.yaml          ← personalidad y comportamiento (editable, TODO_ marca lo que falta llenar)
└── prompt.md                ← prompt del sistema (editable, <business_knowledge> se reescribe por cliente)

src/
├── config.ts                Carga y valida configuracion/ (zod)
├── blocklist.ts             Lista negra de contactos (manual + automática)
├── loop-guard.ts            Detecta que del otro lado hay un bot y lo bloquea
├── index.ts                 Entry point (Express + workers + queue)
├── types.ts                 Tipos compartidos
├── queue.ts                 pg-boss con debounce
├── routes/webhook.ts        POST /webhook/ghl/{whatsapp,facebook,instagram}
├── workers/
│   ├── messageWorker.ts     Procesa mensajes, llama a Claude, ejecuta tools
│   └── followUpWorker.ts    Procesa follow-ups y marca-lead-perdido
├── services/
│   ├── claude.ts            Cliente Anthropic (tool_use + vision + follow-up contextual)
│   ├── ghl.ts                Cliente GHL API (contactos, mensajes, opportunities)
│   ├── ghl-calendar.ts       Cliente GHL Calendars API (slots, citas)
│   ├── follow-up.ts          Scheduling de follow-ups (pg-boss)
│   └── whisper.ts            Transcripción de audios (OpenAI)
├── db/
│   ├── client.ts             Pool de Postgres
│   ├── schema.ts             Migraciones SQL
│   └── migrate.ts            Runner de migraciones
└── prompts/system.ts         Renderiza el prompt desde configuracion/
```

## Cómo agregar una herramienta nueva

Las herramientas (tools) son funciones que Claude puede llamar para hacer cosas: agendar una cita, consultar un calendario, transferir a un humano, guardar un dato, etc.

1. Define la tool en `src/services/claude.ts` → `buildTools()` (input_schema + descripción; se activa solo si el bloque correspondiente existe en `bot.config.yaml`, sigue el mismo patrón que las que ya hay).
2. Implementa el handler en `src/workers/messageWorker.ts` → `handleTool()`.
3. Documenta cuándo usarla en `configuracion/prompt.md` dentro de `<tools>`.
