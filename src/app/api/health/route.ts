import { accessSync, constants } from 'node:fs';

import { tryGetServerEnv } from '@/lib/config/env';
import { prisma } from '@/lib/prisma/client';
import { AdoClient } from '@/services/ado/client';
import { getAuthenticatedIdentity } from '@/services/ado/repositories';
import { handle, ok } from '@/lib/validation/http';

export const dynamic = 'force-dynamic';

/**
 * Connection and environment health, surfaced in the dashboard header.
 *
 * Checks the three things that actually break on this machine: the ADO PAT,
 * TLS through the Zscaler proxy, and the git executable (where `git` on PATH
 * resolves to a zero-byte stub in C:\WINDOWS\system32).
 */

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remedy?: string;
}

interface Identity {
  id: string;
  displayName: string;
  email?: string;
}

export interface HealthResponse {
  ok: boolean;
  organization: string | null;
  project: string | null;
  identity: Identity | null;
  checks: CheckResult[];
}

export async function GET() {
  return handle('health', async () => {
    const checks: CheckResult[] = [];

    const envResult = tryGetServerEnv();
    if (!envResult.ok) {
      checks.push({
        name: 'configuration',
        ok: false,
        detail: envResult.issues.join('; '),
        remedy: 'Fix .env.local and restart the dev server.',
      });
      return ok<HealthResponse>({
        ok: false,
        organization: null,
        project: null,
        identity: null,
        checks,
      });
    }

    const env = envResult.env;
    checks.push({ name: 'configuration', ok: true, detail: 'All required values present.' });

    // Database
    try {
      await prisma.releaseBranchConfig.count();
      checks.push({ name: 'database', ok: true, detail: 'SQLite reachable.' });
    } catch (error) {
      checks.push({
        name: 'database',
        ok: false,
        detail: (error as Error).message,
        remedy: 'Run `npm run db:push`.',
      });
    }

    // Git executable
    try {
      accessSync(env.GIT_EXECUTABLE, constants.X_OK);
      checks.push({ name: 'git', ok: true, detail: env.GIT_EXECUTABLE });
    } catch {
      checks.push({
        name: 'git',
        ok: false,
        detail: `Not executable: ${env.GIT_EXECUTABLE}`,
        remedy:
          'Set GIT_EXECUTABLE to the full path of git.exe. Note that `git` on PATH ' +
          'resolves to a zero-byte stub in C:\\WINDOWS\\system32 on this machine.',
      });
    }

    // CA bundle
    if (env.caBundlePath) {
      try {
        accessSync(env.caBundlePath, constants.R_OK);
        checks.push({ name: 'ca-bundle', ok: true, detail: env.caBundlePath });
      } catch {
        checks.push({
          name: 'ca-bundle',
          ok: false,
          detail: `Unreadable: ${env.caBundlePath}`,
          remedy: 'Run `npm run ca:export`.',
        });
      }
    }

    // ADO reachability and identity
    let identity: Identity | null = null;
    try {
      identity = await getAuthenticatedIdentity(AdoClient.fromEnv());
      checks.push({
        name: 'azure-devops',
        ok: true,
        detail: `Authenticated as ${identity.displayName}.`,
      });
    } catch (error) {
      checks.push({
        name: 'azure-devops',
        ok: false,
        detail: (error as Error).message,
      });
    }

    return ok<HealthResponse>({
      ok: checks.every((check) => check.ok),
      organization: env.ADO_ORG_URL,
      project: env.ADO_PROJECT,
      identity,
      checks,
    });
  });
}
