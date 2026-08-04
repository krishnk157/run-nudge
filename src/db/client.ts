import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { databaseUrl } from "@/lib/env";
import * as schema from "./schema";

type Sql = ReturnType<typeof postgres>;
type Db = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  var __runNudgeSql: Sql | undefined;
}

/**
 * One connection per serverless invocation (Neon's pooler does the real pooling),
 * cached on globalThis so `next dev` hot reloads don't leak connections.
 */
function createSql(): Sql {
  return postgres(databaseUrl(), {
    max: 1,
    idle_timeout: 20,
    prepare: false, // pgbouncer transaction mode doesn't support prepared statements
  });
}

let _sql: Sql | undefined;
let _db: Db | undefined;

/**
 * Connections are created on first use, not at import. `next build` imports
 * every route to collect page data, and a build machine has no reason to hold
 * database credentials.
 */
function getSql(): Sql {
  if (_sql) return _sql;
  _sql = globalThis.__runNudgeSql ?? createSql();
  if (process.env.NODE_ENV !== "production") globalThis.__runNudgeSql = _sql;
  return _sql;
}

function getDb(): Db {
  _db ??= drizzle(getSql(), { schema });
  return _db;
}

/**
 * Lazily-connected handles that still read like plain objects at the call site.
 * The proxy target is a function so that postgres.js's tagged-template form
 * (sql`select 1`) keeps working through it.
 */
function lazy<T extends object>(resolve: () => T): T {
  const callableStub = function () {} as unknown as T;
  return new Proxy(callableStub, {
    get(_target, prop) {
      const target = resolve() as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
    has: (_target, prop) => prop in resolve(),
    apply: (_target, thisArg, args) =>
      Reflect.apply(
        resolve() as unknown as (...a: unknown[]) => unknown,
        thisArg,
        args,
      ),
  });
}

export const sql: Sql = lazy(getSql);
export const db: Db = lazy(getDb);
export { schema };
