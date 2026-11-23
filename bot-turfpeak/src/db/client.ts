/**
 * Flash Peak TMS - Database Client Adapter
 * 
 * Implements authoritative Turso / libSQL database connection.
 * 
 * -----------------------------------------------------------------------------
 * ARCHITECTURAL EVALUATION NOTE: Drizzle ORM Compatibility (Task 0.4)
 * -----------------------------------------------------------------------------
 * Compatibility:
 * - Drizzle ORM provides official support for Turso via `drizzle-orm/libsql`
 *   and wraps `@libsql/client` seamlessly.
 * 
 * Decision for MVP:
 * - We use `@libsql/client` directly with raw SQL migrations and typed query
 *   wrappers.
 * - Rationale:
 *   1. Full transparency and zero-abstraction overhead on resource-constrained VM (~1GB RAM).
 *   2. Guaranteed execution of explicit SQLite PRAGMAs (`foreign_keys = ON`).
 *   3. Deterministic schema migrations without runtime schema-drift or codegen steps.
 *   4. Seamless compatibility if Drizzle schema mapping is added in later iterations.
 */

import { createClient, type Client, type Config } from '@libsql/client';

let globalClient: Client | null = null;

export interface DatabaseConfig {
  url?: string;
  authToken?: string;
}

/**
 * Creates or retrieves the singleton libSQL database client.
 */
export function getDb(config?: DatabaseConfig): Client {
  if (config) {
    return createClient({
      url: config.url || process.env.TURSO_DATABASE_URL || 'file:local.sqlite',
      authToken: config.authToken || process.env.TURSO_AUTH_TOKEN,
    });
  }

  if (!globalClient) {
    const url = process.env.TURSO_DATABASE_URL || 'file:local.sqlite';
    const authToken = process.env.TURSO_AUTH_TOKEN;

    const clientConfig: Config = {
      url,
      ...(authToken && url.startsWith('libsql://') ? { authToken } : {}),
    };

    globalClient = createClient(clientConfig);
  }

  return globalClient;
}

/**
 * Closes and resets the singleton client (useful in test teardowns).
 */
export function closeDb(): void {
  if (globalClient) {
    globalClient.close();
    globalClient = null;
  }
}
