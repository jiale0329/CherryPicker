/**
 * Azure DevOps deep links.
 *
 * The organisation URL and project come from configuration rather than source,
 * so every builder here returns `null` when either is missing and callers
 * render plain text instead of a dead link.
 */

function base(orgUrl: string | null | undefined, project: string | null | undefined): string | null {
  if (!orgUrl || !project) return null;
  return `${orgUrl.replace(/\/+$/, '')}/${encodeURIComponent(project)}`;
}

/** Work item page, e.g. `.../jemsmm/_workitems/edit/1507096`. */
export function workItemUrl(
  orgUrl: string | null | undefined,
  project: string | null | undefined,
  workItemId: number | null | undefined,
): string | null {
  const prefix = base(orgUrl, project);
  if (!prefix || !workItemId) return null;
  return `${prefix}/_workitems/edit/${workItemId}`;
}

/** Pull request page, e.g. `.../jemsmm/_git/core-application/pullrequest/384144`. */
export function pullRequestUrl(
  orgUrl: string | null | undefined,
  project: string | null | undefined,
  repositoryName: string,
  pullRequestId: number,
): string | null {
  const prefix = base(orgUrl, project);
  if (!prefix) return null;
  return `${prefix}/_git/${encodeURIComponent(repositoryName)}/pullrequest/${pullRequestId}`;
}
