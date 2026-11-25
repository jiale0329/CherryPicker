import path from 'node:path';

import { z } from 'zod';

/**
 * Server-only environment configuration.
 *
 * Importing this from a client component is a build error, which is the point:
 * ADO_PAT must never reach the browser.
 */

const schema = z.object({
  ADO_ORG_URL: z
    .string()
    .url('ADO_ORG_URL must be a full URL, e.g. https://dev.azure.com/jblprd')
    .transform((value) => value.replace(/\/+$/, '')),
  ADO_PROJECT: z.string().min(1, 'ADO_PROJECT is required'),
  ADO_PAT: z.string().min(1, 'ADO_PAT is required'),

  /**
   * PEM bundle of trusted roots. Needed because this network terminates TLS
   * with Zscaler and Node does not read the Windows certificate store.
   * Regenerate with `npm run ca:export`.
   */
  ADO_CA_BUNDLE: z.string().optional(),

  /**
   * Absolute path to git.exe. Not optional in practice on this machine: `git`
   * on PATH resolves to a zero-byte stub in C:\WINDOWS\system32 that shadows
   * the real install.
   */
  GIT_EXECUTABLE: z.string().min(1).default('git'),
  GIT_ASKPASS_SCRIPT: z.string().default('scripts/git-askpass.cmd'),
  GIT_MIRROR_DIR: z.string().default('.repo-cache'),
  GIT_WORKTREE_DIR: z.string().default('.worktrees'),
  GIT_AUTHOR_NAME: z.string().default('Release Backport Manager'),
  GIT_AUTHOR_EMAIL: z.string().email().optional(),

  DATABASE_URL: z.string().default('file:./prisma/dev.db'),

  BACKPORT_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),

  /**
   * Serves the dashboard from fixture data instead of ADO. For UI work and
   * tests only; it is a separate data source, never a fallback when a real
   * ADO call fails.
   */
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export type ServerEnv = z.infer<typeof schema> & {
  /** Absolute path to the CA bundle, or undefined when not configured. */
  caBundlePath?: string;
  askPassPath: string;
  mirrorPath: string;
  worktreePath: string;
};

let cached: ServerEnv | null = null;

function resolveFromRoot(relative: string): string {
  if (path.isAbsolute(relative)) return relative;
  // These paths are user-configurable (CA bundle, git mirror, worktrees), so the
  // bundler cannot know them statically. Without the ignore hint it traces the
  // entire project into the server output.
  return path.join(/* turbopackIgnore: true */ process.cwd(), relative);
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid server configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const value = parsed.data;
  cached = {
    ...value,
    caBundlePath: value.ADO_CA_BUNDLE ? resolveFromRoot(value.ADO_CA_BUNDLE) : undefined,
    askPassPath: resolveFromRoot(value.GIT_ASKPASS_SCRIPT),
    mirrorPath: resolveFromRoot(value.GIT_MIRROR_DIR),
    worktreePath: resolveFromRoot(value.GIT_WORKTREE_DIR),
  };
  return cached;
}

/** Test seam: drop the memoised value so a test can change process.env. */
export function resetServerEnvCache(): void {
  cached = null;
}

/**
 * Non-throwing variant for health checks and the settings page, which need to
 * report misconfiguration rather than crash the request.
 */
export function tryGetServerEnv():
  | { ok: true; env: ServerEnv }
  | { ok: false; issues: string[] } {
  try {
    return { ok: true, env: getServerEnv() };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, issues: error.issues };
    return { ok: false, issues: [(error as Error).message] };
  }
}
