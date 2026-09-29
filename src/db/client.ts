import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { requireDatabaseUrl } from '../env';

dotenv.config();

export const db = new Pool({
  connectionString: requireDatabaseUrl(),
  ssl: false,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

db.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err);
});
