import { Pool } from 'pg';

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    max: 5,
  });
}
