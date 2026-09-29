import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Everything the API writes to its log goes through this file, as one JSON object per line.
 *
 * Where it goes: to the invocation's own logger when there is one, so the line reaches Application
 * Insights as a trace under the function's category and carries the request's operation id; to the
 * console otherwise (tests, local runs, module start-up). src/index.ts binds the logger for every
 * invocation with a pre-invocation hook.
 *
 * Why JSON: the saved queries in ops/queries, the alerts in infra/monitoring.bicep and the workbook
 * read these lines with parse_json(Message). Change a field name here and change it there.
 *
 * What never goes in: request bodies, API keys, email addresses, user ids, and the message of an
 * unexpected error. SECURITY.md promises a pasted RIPE Atlas key cannot reach a log. Callers pass
 * fixed strings and ids of public objects, and every line is scrubbed before it is written as a
 * second line of defence: anything shaped like a UUID (every RIPE Atlas key is one; this API's own
 * ids are not) and anything shaped like an email address is replaced. api/test/telemetry.test.ts
 * holds both properties.
 */

/** The part of the Functions InvocationContext used here, so tests can pass a plain object. */
export interface LogSink {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export const invocationLog = new AsyncLocalStorage<LogSink>();

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Replace anything that could be a RIPE Atlas key or an email address. */
export function scrub(text: string): string {
  return text.replace(UUID_RE, '[uuid]').replace(EMAIL_RE, '[email]');
}

/**
 * How an unexpected error may be written to a log.
 *
 * Never its message. An unknown error is unknown: whatever threw it may have folded the request
 * body, which on the pledge route carries the donor's key, into free text. Two places here
 * previously said that in a comment and then logged the message anyway.
 *
 * What is left is still enough to work with, because the errors that actually reach these paths
 * are Azure storage errors: the class name, the service's own error code, and the HTTP status are
 * all fixed identifiers chosen by the SDK rather than anything derived from the request.
 */
export function describeErrorForLog(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const { code, statusCode } = err as { code?: unknown; statusCode?: unknown };
  const parts = [err.name || 'Error'];
  if (typeof code === 'string') parts.push(`code=${code}`);
  if (typeof statusCode === 'number') parts.push(`status=${statusCode}`);
  return parts.join(' ');
}

type Level = 'info' | 'warn' | 'error';
type Field = string | number | boolean | null | undefined;

function write(level: Level, line: Record<string, Field>): void {
  const text = scrub(JSON.stringify(line));
  const sink: LogSink = invocationLog.getStore() ?? console;
  sink[level](text);
}

/**
 * A named event with a few fields, e.g. logEvent('transfer', { outcome: 'confirmed' }).
 * Field values must be fixed strings, numbers or ids of public objects.
 */
export function logEvent(event: string, fields: Record<string, Field> = {}, level: Level = 'info'): void {
  write(level, { ...fields, event });
}

/**
 * Something went wrong that the request survived or reported. `message` is a fixed sentence
 * written here in the code; `err`, when given, is reduced to describeErrorForLog.
 */
export function logError(message: string, err?: unknown): void {
  write('error', { event: 'error', message, error: err === undefined ? undefined : describeErrorForLog(err) });
}

export interface Dependency {
  /** "RIPE Atlas" or "Table Storage". */
  type: string;
  /** Host name only. */
  target: string;
  /** Method and a path with no query string and no keys, e.g. "POST /credits/transfers/". */
  name: string;
  /** HTTP status, or "timeout" / "network" when no answer came back. */
  resultCode: string;
  /** Whether the service answered. A 4xx is an answer; a 5xx, a timeout or a network error is not. */
  success: boolean;
  durationMs: number;
}

/** One line per outbound call. Read by ops/queries/ripe-atlas.kql and table-storage.kql. */
export function logDependency(d: Dependency): void {
  write(d.success ? 'info' : 'warn', {
    event: 'dependency',
    type: d.type,
    target: d.target,
    name: d.name,
    resultCode: d.resultCode,
    success: d.success,
    durationMs: Math.round(d.durationMs),
  });
}

/**
 * Name a Table Storage request without anything from its keys or filter.
 *
 * Partition and row keys here include user ids (the owner index partitions are `owner-<user id>`),
 * and filters quote them, so the URL is reduced to the table and the kind of operation.
 */
export function tableOperation(method: string, url: string): string {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return `${method} (unparsed)`;
  }
  // Azurite puts the account name first: /devstoreaccount1/projects(...)
  const segment = path.split('/').filter(Boolean).pop() ?? '';
  const match = /^([A-Za-z][A-Za-z0-9]*|\$batch)(\((.*)\))?$/.exec(segment);
  if (!match) return `${method} (other)`;
  const [, table, parens, inner] = match;
  if (table === 'Tables') return `${method} Tables`;
  if (table === '$batch') return `${method} batch`;
  if (parens && inner) return `${method} ${table} entity`;
  return `${method} ${table} query`;
}

/**
 * A pipeline policy for TableClient that logs every Table Storage request as a dependency.
 * Per retry, so a retried call shows each attempt.
 */
export function tableDependencyPolicy() {
  return {
    name: 'atlasRelayDependencyLog',
    async sendRequest<Req extends { url: string; method: string }, Res extends { status: number }>(
      request: Req,
      next: (request: Req) => Promise<Res>,
    ): Promise<Res> {
      const started = performance.now();
      const name = tableOperation(request.method, request.url);
      let target = 'table storage';
      try {
        target = new URL(request.url).host;
      } catch {
        // keep the placeholder
      }
      try {
        const res = await next(request);
        logDependency({ type: 'Table Storage', target, name, resultCode: String(res.status), success: res.status < 500, durationMs: performance.now() - started });
        return res;
      } catch (err) {
        const status = (err as { statusCode?: unknown }).statusCode;
        const answered = typeof status === 'number';
        logDependency({
          type: 'Table Storage',
          target,
          name,
          resultCode: answered ? String(status) : 'network',
          success: answered && (status as number) < 500,
          durationMs: performance.now() - started,
        });
        throw err;
      }
    },
  };
}
