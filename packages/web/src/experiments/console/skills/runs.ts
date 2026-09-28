import { requestJson } from '../lib/http';
import { toRun, type Run } from '../primitives/run';
import { toRunEvent, type RunEvent } from '../primitives/event';
import type { RunStatus } from '../lib/run-status';
import type { components } from '@/lib/api.generated';

export interface ListRunsOptions {
  codebaseId?: string;
  status?: RunStatus;
  after?: string;
  limit?: number;
  offset?: number;
}

export interface RunCounts {
  all: number;
  running: number;
  paused: number;
  failed: number;
  completed: number;
  cancelled: number;
  pending: number;
}

interface DashboardRunsResponse {
  runs: Parameters<typeof toRun>[0][];
  total: number;
  counts: Partial<RunCounts>;
}

function normalizeCounts(c: Partial<RunCounts>): RunCounts {
  return {
    all: c.all ?? 0,
    running: c.running ?? 0,
    paused: c.paused ?? 0,
    failed: c.failed ?? 0,
    completed: c.completed ?? 0,
    cancelled: c.cancelled ?? 0,
    pending: c.pending ?? 0,
  };
}

export async function listRuns(
  opts: ListRunsOptions = {}
): Promise<{ runs: Run[]; counts: RunCounts; total: number }> {
  const qs = new URLSearchParams();
  if (opts.codebaseId !== undefined) qs.set('codebaseId', opts.codebaseId);
  if (opts.status !== undefined) qs.set('status', opts.status);
  if (opts.after !== undefined) qs.set('after', opts.after);
  if (opts.limit !== undefined) qs.set('limit', opts.limit.toString());
  if (opts.offset !== undefined) qs.set('offset', opts.offset.toString());
  const url = `/api/dashboard/runs${qs.size > 0 ? `?${qs.toString()}` : ''}`;
  const res = await requestJson<DashboardRunsResponse>(url);
  return {
    runs: res.runs.map(toRun),
    counts: normalizeCounts(res.counts),
    total: res.total,
  };
}

export async function listCostRuns(codebaseId: string, after?: string): Promise<Run[]> {
  const pageSize = 200;
  const runs: Run[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await listRuns({ codebaseId, after, limit: pageSize, offset });
    runs.push(...page.runs);
    if (runs.length >= page.total || page.runs.length < pageSize) break;
  }
  return Promise.all(
    runs.map(async run => {
      if (run.parentRunId !== null || run.costUsd === null) return run;
      const detail = await getRun(run.id);
      const byModel = new Map<string, NonNullable<Run['modelCosts']>[number]>();
      for (const event of detail.events) {
        if (
          event.kind !== 'node_transition' ||
          (event.transition !== 'completed' && event.transition !== 'failed') ||
          event.model === null ||
          event.costUsd === null
        )
          continue;
        const prior = byModel.get(event.model) ?? {
          model: event.model,
          costUsd: 0,
          calls: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheWrite: 0,
          inputCostUsd: 0,
          outputCostUsd: 0,
          cacheReadCostUsd: 0,
          cacheWriteCostUsd: 0,
          partial: false,
        };
        const tokens = event.tokens;
        const costs = tokens?.costBreakdown;
        byModel.set(event.model, {
          ...prior,
          costUsd: prior.costUsd + event.costUsd,
          calls: prior.calls + 1,
          tokensIn: prior.tokensIn + (tokens?.input ?? 0),
          tokensOut: prior.tokensOut + (tokens?.output ?? 0),
          cacheRead: prior.cacheRead + (tokens?.cacheRead ?? 0),
          cacheWrite: prior.cacheWrite + (tokens?.cacheWrite ?? 0),
          inputCostUsd:
            prior.inputCostUsd !== null && costs ? prior.inputCostUsd + costs.input : null,
          outputCostUsd:
            prior.outputCostUsd !== null && costs ? prior.outputCostUsd + costs.output : null,
          cacheReadCostUsd:
            prior.cacheReadCostUsd !== null && costs
              ? prior.cacheReadCostUsd + costs.cacheRead
              : null,
          cacheWriteCostUsd:
            prior.cacheWriteCostUsd !== null && costs
              ? prior.cacheWriteCostUsd + costs.cacheWrite
              : null,
          partial:
            prior.partial ||
            tokens === null ||
            tokens.cachePartial === true ||
            tokens.cacheRead === undefined ||
            tokens.cacheWrite === undefined,
        });
      }
      return { ...run, modelCosts: [...byModel.values()] };
    })
  );
}

export async function listGlobalCounts(): Promise<RunCounts> {
  // Counts without any codebase filter — used by top chrome pill.
  const res = await requestJson<DashboardRunsResponse>('/api/dashboard/runs?limit=1');
  return normalizeCounts(res.counts);
}

interface RunDetailResponse {
  run: Parameters<typeof toRun>[0];
  events: Parameters<typeof toRunEvent>[0][];
}

export async function getRun(id: string): Promise<{ run: Run; events: RunEvent[] }> {
  const res = await requestJson<RunDetailResponse>(`/api/workflows/runs/${encodeURIComponent(id)}`);
  return {
    run: toRun(res.run),
    events: res.events.map(toRunEvent),
  };
}

export async function cancelRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function approveRun(id: string, comment?: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    body: JSON.stringify(comment !== undefined ? { comment } : {}),
  });
}

export async function rejectRun(id: string, reason: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Resolve a paused run with any of its gate's declared decisions (#2707 step 2).
 * `approve`/`reject` produce the exact same resolution as `approveRun`/`rejectRun` —
 * the server delegates those two ids to the same functions — so callers can use this
 * uniformly instead of branching on decision id.
 */
export async function respondRun(id: string, decision: string, text?: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/respond`, {
    method: 'POST',
    body: JSON.stringify(text !== undefined ? { decision, text } : { decision }),
  });
}

export async function resumeRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function abandonRun(id: string): Promise<void> {
  await requestJson(`/api/workflows/runs/${encodeURIComponent(id)}/abandon`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

/**
 * Re-exported from the generated OpenAPI types so the console doesn't drift
 * from the server contract. Schema lives in
 * packages/server/src/routes/schemas/workflow.schemas.ts.
 */
export type ArtifactFile = components['schemas']['ArtifactFile'];
type ListArtifactsResponse = components['schemas']['ListArtifactsResponse'];

export async function listRunArtifacts(runId: string): Promise<ArtifactFile[]> {
  const res = await requestJson<ListArtifactsResponse>(
    `/api/runs/${encodeURIComponent(runId)}/artifacts`
  );
  return res.files;
}

/** Fetch a single artifact file as text (markdown or plain). */
export async function fetchArtifact(runId: string, path: string): Promise<string> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(`/api/artifacts/${encodeURIComponent(runId)}/${encodedPath}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to fetch artifact: ${res.status.toString()}`);
  }
  return res.text();
}
