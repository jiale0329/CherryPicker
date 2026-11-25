import { readFileSync } from 'node:fs';

import { Agent, type Dispatcher } from 'undici';
import { z } from 'zod';

import { getServerEnv } from '@/lib/config/env';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('ado');

export class AdoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'AdoApiError';
  }

  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export class AdoTlsError extends Error {
  constructor(readonly code: string) {
    super(
      `TLS handshake with Azure DevOps failed (${code}). This network terminates ` +
        'TLS with Zscaler and Node does not read the Windows certificate store. ' +
        'Regenerate the CA bundle with `npm run ca:export` and make sure ' +
        'ADO_CA_BUNDLE points at it.',
    );
    this.name = 'AdoTlsError';
  }
}

/**
 * Query value encoder that preserves forward slashes.
 *
 * This matters more than it looks. Azure DevOps accepts
 * `searchCriteria.targetRefName=refs%2Fheads%2Frelease%2F26.2.1.PRE` with a 200
 * response but silently ignores the filter, returning every completed PR in the
 * repository. Percent-encoding the slashes therefore produces wrong data rather
 * than an error. Slashes are legal unescaped in a query value (RFC 3986), so we
 * encode everything else and leave them alone.
 */
function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface AdoRequestOptions {
  /** Appended as `api-version`. Branch policies need `7.1-preview.1`. */
  apiVersion?: string;
  query?: QueryParams;
  /** Scope the path to the project. Org-level calls set this false. */
  projectScoped?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_API_VERSION = '7.1';
const MAX_ATTEMPTS = 4;

let dispatcher: Dispatcher | undefined;

/**
 * Node's global fetch ignores `https.globalAgent`, so a CA added there has no
 * effect. Supplying an undici Agent as the dispatcher is the way to make the
 * bundle apply without setting NODE_TLS_REJECT_UNAUTHORIZED=0, which would
 * disable verification for every request including the PAT-bearing ones.
 */
function getDispatcher(): Dispatcher | undefined {
  if (dispatcher) return dispatcher;

  const { caBundlePath } = getServerEnv();
  if (!caBundlePath) return undefined;

  try {
    const ca = readFileSync(caBundlePath, 'utf8');
    dispatcher = new Agent({ connect: { ca } });
    log.debug('loaded CA bundle', { path: caBundlePath, bytes: ca.length });
  } catch (error) {
    log.warn('could not read CA bundle; falling back to system trust store', {
      path: caBundlePath,
      error: (error as Error).message,
    });
    return undefined;
  }

  return dispatcher;
}

/** Test seam, since the dispatcher is memoised per process. */
export function resetAdoDispatcher(): void {
  dispatcher = undefined;
}

function authHeader(pat: string): string {
  // ADO PAT auth is HTTP Basic with an empty username.
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, attempt: number): number {
  // ADO sets Retry-After on throttling; honour it rather than guessing.
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
  }
  return Math.min(2 ** attempt * 250, 8_000);
}

export interface AdoClientConfig {
  orgUrl: string;
  project: string;
  pat: string;
}

export class AdoClient {
  constructor(private readonly config: AdoClientConfig) {}

  static fromEnv(): AdoClient {
    const env = getServerEnv();
    return new AdoClient({
      orgUrl: env.ADO_ORG_URL,
      project: env.ADO_PROJECT,
      pat: env.ADO_PAT,
    });
  }

  get project(): string {
    return this.config.project;
  }

  get orgUrl(): string {
    return this.config.orgUrl;
  }

  private buildUrl(apiPath: string, options: AdoRequestOptions): string {
    const scoped = options.projectScoped !== false;
    const prefix = scoped ? `${this.config.orgUrl}/${this.config.project}` : this.config.orgUrl;
    const normalised = apiPath.replace(/^\/+/, '');

    const params: string[] = [`api-version=${options.apiVersion ?? DEFAULT_API_VERSION}`];
    for (const [key, raw] of Object.entries(options.query ?? {})) {
      if (raw === undefined) continue;
      params.push(`${encodeQueryValue(key)}=${encodeQueryValue(String(raw))}`);
    }

    return `${prefix}/${normalised}?${params.join('&')}`;
  }

  /** GET and validate against a schema. Throws AdoApiError on a non-2xx. */
  async get<T extends z.ZodTypeAny>(
    apiPath: string,
    schema: T,
    options: AdoRequestOptions = {},
  ): Promise<z.infer<T>> {
    const body = await this.request('GET', apiPath, undefined, options);
    return this.parse(schema, body, apiPath);
  }

  async post<T extends z.ZodTypeAny>(
    apiPath: string,
    payload: unknown,
    schema: T,
    options: AdoRequestOptions = {},
  ): Promise<z.infer<T>> {
    const body = await this.request('POST', apiPath, payload, options);
    return this.parse(schema, body, apiPath);
  }

  async patch<T extends z.ZodTypeAny>(
    apiPath: string,
    payload: unknown,
    schema: T,
    options: AdoRequestOptions = {},
  ): Promise<z.infer<T>> {
    const body = await this.request('PATCH', apiPath, payload, options);
    return this.parse(schema, body, apiPath);
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, apiPath: string): z.infer<T> {
    const result = schema.safeParse(body);
    if (!result.success) {
      const summary = result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      log.error('unexpected ADO response shape', { path: apiPath, issues: summary });
      throw new AdoApiError(
        `Azure DevOps returned an unexpected shape for ${apiPath}: ${summary}`,
        200,
        apiPath,
      );
    }
    return result.data;
  }

  private async request(
    method: string,
    apiPath: string,
    payload: unknown,
    options: AdoRequestOptions,
  ): Promise<unknown> {
    const url = this.buildUrl(apiPath, options);
    const headers: Record<string, string> = {
      Authorization: authHeader(this.config.pat),
      Accept: 'application/json',
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: options.signal,
          dispatcher: getDispatcher(),
        } as RequestInit & { dispatcher?: Dispatcher });

        if (isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS - 1) {
          const delay = retryDelayMs(response, attempt);
          log.warn('ADO throttled or unavailable; retrying', {
            path: apiPath,
            status: response.status,
            attempt: attempt + 1,
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new AdoApiError(
            describeHttpFailure(response.status, apiPath, text),
            response.status,
            apiPath,
            text.slice(0, 2_000),
          );
        }

        // Some ADO endpoints answer 204 with an empty body.
        if (response.status === 204) return {};
        return await response.json();
      } catch (error) {
        if (error instanceof AdoApiError) throw error;

        const cause = (error as { cause?: { code?: string } }).cause;
        const code = cause?.code;
        if (code && /CERT|SSL|ISSUER/i.test(code)) throw new AdoTlsError(code);

        lastError = error as Error;
        if (attempt < MAX_ATTEMPTS - 1) {
          const delay = Math.min(2 ** attempt * 250, 4_000);
          log.warn('ADO request failed; retrying', {
            path: apiPath,
            error: lastError.message,
            attempt: attempt + 1,
            delayMs: delay,
          });
          await sleep(delay);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`ADO request to ${apiPath} failed`);
  }
}

function describeHttpFailure(status: number, apiPath: string, body: string): string {
  if (status === 401) {
    return 'Azure DevOps rejected the credentials (401). The PAT is probably expired or revoked.';
  }
  if (status === 403) {
    return `Azure DevOps denied access to ${apiPath} (403). The PAT is missing a required scope.`;
  }
  if (status === 404) {
    return `Azure DevOps has no such resource: ${apiPath} (404).`;
  }

  // ADO wraps real detail in a JSON envelope; surface it instead of the status.
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return `Azure DevOps error on ${apiPath} (${status}): ${parsed.message}`;
  } catch {
    /* body was not JSON */
  }
  return `Azure DevOps error on ${apiPath} (${status}).`;
}

export { encodeQueryValue };
