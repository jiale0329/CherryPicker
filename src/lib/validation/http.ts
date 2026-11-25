import { NextResponse } from 'next/server';
import { z } from 'zod';

import { ConfigError } from '@/lib/config/env';
import { createLogger } from '@/lib/logging/logger';
import { AdoApiError, AdoTlsError } from '@/services/ado/client';

const log = createLogger('api');

/**
 * Shared response envelope and error translation for route handlers.
 *
 * Errors are mapped to a stable `code` the UI can branch on, with a message
 * written for the developer using the tool rather than a stack trace. Secrets
 * are stripped by the logger's redaction before anything is written out.
 */

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Concrete next step, when there is one. */
    remedy?: string;
    details?: unknown;
  };
}

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_CONFIGURED'
  | 'ADO_AUTH_FAILED'
  | 'ADO_TLS_FAILED'
  | 'ADO_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export function ok<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, init);
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status: number,
  extra?: { remedy?: string; details?: unknown },
): NextResponse<ApiErrorBody> {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/** Parses and validates search params, returning a typed result. */
export function parseQuery<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; response: NextResponse<ApiErrorBody> } {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const result = schema.safeParse(params);

  if (!result.success) {
    return {
      ok: false,
      response: fail('INVALID_REQUEST', 'Invalid query parameters.', 400, {
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  return { ok: true, data: result.data };
}

export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse<ApiErrorBody> }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: fail('INVALID_REQUEST', 'Request body must be JSON.', 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      response: fail('INVALID_REQUEST', 'Invalid request body.', 400, {
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      }),
    };
  }

  return { ok: true, data: result.data };
}

/** Wraps a handler so every route reports failures the same way. */
export async function handle<T>(
  scope: string,
  run: () => Promise<NextResponse<T> | NextResponse<ApiErrorBody>>,
): Promise<NextResponse<T | ApiErrorBody>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('configuration invalid', { scope, issues: error.issues });
      return fail('NOT_CONFIGURED', 'The server is not configured correctly.', 500, {
        remedy: 'Check .env.local against .env.example, then restart the dev server.',
        details: error.issues,
      });
    }

    if (error instanceof AdoTlsError) {
      log.error('ADO TLS failure', { scope, code: error.code });
      return fail('ADO_TLS_FAILED', error.message, 502, {
        remedy: 'Run `npm run ca:export`, then confirm ADO_CA_BUNDLE points at the bundle.',
      });
    }

    if (error instanceof AdoApiError) {
      log.error('ADO request failed', { scope, status: error.status, path: error.path });
      if (error.isAuthFailure) {
        return fail('ADO_AUTH_FAILED', error.message, 502, {
          remedy: 'Issue a new Personal Access Token and update ADO_PAT in .env.local.',
        });
      }
      return fail('ADO_ERROR', error.message, 502);
    }

    const message = (error as Error).message ?? 'Unexpected error';
    log.error('unhandled route error', { scope, error });
    return fail('INTERNAL', message, 500);
  }
}
