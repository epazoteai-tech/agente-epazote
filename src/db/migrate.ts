import { db } from './client';
import { SCHEMA_SQL } from './schema';

async function migrate() {
  console.log('[migrate] Running schema...');
  await db.query(SCHEMA_SQL);
  console.log('[migrate] Done.');
  await db.end();
}

migrate().catch((err) => {
  console.error('[migrate] Error:', err);
  process.exit(1);
});
