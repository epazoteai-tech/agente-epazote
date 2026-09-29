import * as dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { webhookRouter } from './routes/webhook';
import { startMessageWorker } from './workers/messageWorker';
import { startFollowUpWorker } from './workers/followUpWorker';
import { startReconciliadorWorker } from './workers/reconciliadorWorker';
import { boss, barrerPendientes } from './queue';
import { db } from './db/client';
import { SCHEMA_SQL } from './db/schema';
import { getConfig } from './config';
import { warnIfApiKeysLookSwapped } from './env';
import { verificarLlaves } from './verificar-llaves';

const app = express();
app.use(express.json());

// `version` = el commit que está sirviendo. Un 200 no prueba que tu último
// push esté vivo, prueba que ALGO está vivo (E74): después de cada push,
// comparar este sha con el de main.
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: (process.env.RAILWAY_GIT_COMMIT_SHA ?? 'local').slice(0, 7),
    ts: new Date().toISOString(),
  });
});

app.use('/webhook', webhookRouter);

// Endpoint de admin para debugging — listar las últimas conversaciones.
//
// Va detrás de un token porque devuelve datos de contactos reales (nombre e id
// de GHL de cada persona que le ha escrito al bot). Estuvo abierto a internet
// y cualquiera con la URL podía descargar la lista completa — es el E70 de la
// skill `errores-bot`, que se encontró en producción el 22/09/2026.
//
// Falla CERRADO: sin `ADMIN_TOKEN` seteado nadie entra. Y no tumba el proceso
// al arrancar a propósito: dejar sin WhatsApp a un negocio por una variable
// que solo afecta a un endpoint de debugging sería peor que el hueco.
function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    console.warn('[admin] Rechazado — falta ADMIN_TOKEN en el entorno');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const provided = req.header('x-admin-token') ?? '';
  // Comparación de tiempo constante: un `!==` filtra el token carácter a
  // carácter ante quien pueda medir la respuesta.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn(`[admin] Rechazado | ua="${req.header('user-agent') ?? 'unknown'}"`);
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Express 4 no captura los rechazos de un handler async: sin el try, una
// consulta que falla aquí tumbaba el proceso que atiende WhatsApp (E72).
app.get('/admin/conversations', requireAdminToken, async (_req, res, next) => {
  try {
    const result = await db.query(
      'SELECT contact_id, contact_name, last_activity FROM conversations ORDER BY last_activity DESC LIMIT 20'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

// Middleware global de errores — captura cualquier error async de las rutas
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
});

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Cargar y validar configuracion/bot.config.yaml antes que nada — si tiene
  // un error, mejor fallar acá con un mensaje claro que más adelante.
  const config = getConfig();
  console.log(`[config] Loaded for bot=${config.bot.name} (${config.business.name})`);

  warnIfApiKeysLookSwapped();

  await db.query('SELECT 1');
  console.log('[db] Connected');

  // Migraciones idempotentes (IF NOT EXISTS) — corren en cada arranque
  await db.query(SCHEMA_SQL);
  console.log('[db] Migrations applied');

  await boss.start();
  console.log('[queue] pg-boss started');

  await startMessageWorker(config.behavior.worker_concurrency);

  // El barrido de mensajes que GHL no avisó (E144). No es opcional: el defecto
  // es de GHL, no de este restaurante. Ver workers/reconciliadorWorker.ts.
  await startReconciliadorWorker();

  // El worker de follow-ups solo arranca si hay bloque follow_ups: en el yaml.
  if (config.follow_ups) {
    await startFollowUpWorker(1);
  }

  // Barredor de mensajes que se quedaron sin turno (E150), cada minuto.
  setInterval(() => {
    barrerPendientes((sql, params) => db.query(sql, params)).catch(() => {});
  }, 60_000);

  app.listen(PORT, () => {
    console.log(`[server] ${config.bot.name} listening on port ${PORT}`);

    // Verificación de credenciales CONTRA el proveedor (ver verificar-llaves.ts).
    // Va aquí, después de escuchar el puerto y sin await, para que el
    // healthcheck de la plataforma no dependa de que tres APIs contesten.
    void verificarLlaves();
  });
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

// Graceful shutdown — Railway manda SIGTERM antes de matar el contenedor.
// Deja que los jobs activos terminen antes de apagarse.
async function shutdown() {
  console.log('[shutdown] Stopping worker and queue...');
  await boss.stop({ graceful: true, timeout: 30000 });
  await db.end();
  console.log('[shutdown] Done.');
  process.exit(0);
}

// Lo que falla en una parte no puede llevarse la parte que da de comer: un
// rechazo sin capturar en cualquier rincón mataba el proceso del bot (E72).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
