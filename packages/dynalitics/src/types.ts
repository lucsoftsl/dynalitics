import type { DriverAdapter } from './driver/types.js';
import type { SafeCause } from './errors.js';
import type { Logger } from './logger.js';
import type { TableRef } from './model/identifiers.js';
import type {
  ColumnModel,
  CustomFieldDef,
  CustomValue,
  Dialect,
  IpMode,
  Role,
} from './model/types.js';

/** pool: pg.Pool | mysql2 promise Pool | mssql.ConnectionPool */
export type Credential = { connectionString: string } | { pool: unknown };

export interface DynaliticsConfig {
  /** The adapter package's export, e.g. `import { postgres } from 'dynalitics-postgres'`. Supplies the dialect. */
  adapter: DriverAdapter;
  /** Recommended: { writer, reader }. A single Credential is "single-user mode" and logs a warning. */
  connection: Credential | { writer?: Credential; reader?: Credential };
  acknowledgeSingleCredential?: boolean;
  poolSize?: number;
  connectTimeoutMs?: number;
  table: string | { database?: string; schema?: string; name: string };
  tableMode?: 'recommended' | 'existing';
  columns?: Partial<Record<Role, string | false>>;
  customFields?: Record<string, CustomFieldDef>;
  /** normalize: host hook that maps a path to a route template (e.g. /users/42 -> /users/:id). Runs in host code. */
  page?: { keepQuery?: boolean; maxLength?: number; normalize?: (path: string) => string };
  ip?: { mode?: IpMode; salt?: string; ipv4Prefix?: number; ipv6Prefix?: number };
  consent?: { default?: (visit: Readonly<Visit>) => boolean };
  /** WRITE-TIME first-visit detection. Opt-in; the default is read-time computation in the read handler. */
  firstVisit?: { enabled?: boolean; cacheSize?: number };
  queue?: {
    maxSize?: number;
    batchSize?: number;
    flushIntervalMs?: number;
    backpressure?: 'drop' | 'block';
    maxBlockMs?: number;
    retry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
  };
  limits?: { customMaxKeys?: number; customMaxBytes?: number; oversize?: 'truncate' | 'reject' };
  validateOnStart?: 'strict' | 'skip';
  onError?: (info: ErrorInfo) => void;
  logger?: Logger;
}

export interface Visit {
  pageVisited: string;
  consent?: boolean;
  ip?: string | null;
  userId?: string | number | null;
  username?: string | null;
  email?: string | null;
  custom?: Readonly<Record<string, CustomValue>>;
}

export type TrackResult =
  | { status: 'queued' }
  | { status: 'dropped'; reason: 'queue_full' | 'block_timeout' | 'closed' }
  | { status: 'rejected'; issues: readonly string[] };

export interface FlushResult {
  written: number;
  failed: number;
  timedOut: boolean;
}

export interface DynaliticsStats {
  queued: number;
  written: number;
  droppedFull: number;
  rejected: number;
  failed: number;
  queueLength: number;
  /** 0 unless firstVisit.enabled (write-time detection). */
  lruSize: number;
  lastErrorAt: string | null;
}

export type ErrorCode =
  | 'invalid_visit'
  | 'unknown_custom_field'
  | 'invalid_ip'
  | 'queue_full'
  | 'insert_failed'
  | 'lookup_failed'
  | 'consent_resolver_failed'
  | 'consent_missing'
  | 'compute_failed'
  | 'authorize_invalid_result'
  | 'invalid_user_id'
  | 'internal';

export interface ErrorInfo {
  code: ErrorCode;
  /** Already redacted. */
  message: string;
  /** Coalesced repeats. */
  count?: number;
  /** Events lost, for insert_failed / queue_full. */
  dropped?: number;
  cause?: SafeCause;
}

export interface Dynalitics {
  /** Never throws, never rejects. Resolves when the event is accepted into the queue (not when it is written). */
  track(visit: Visit): Promise<TrackResult>;
  /** Resolves when everything queued at call time has been written or has permanently failed. Never rejects. */
  flush(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  /** Stops accepting events, flushes, then closes owned pools. Idempotent. */
  close(opts?: { timeoutMs?: number }): Promise<FlushResult>;
  stats(): Readonly<DynaliticsStats>;
  readonly model: ColumnModel;
  readonly capabilities: { readonly canWrite: boolean; readonly canRead: boolean };
  readonly table: TableRef;
}
