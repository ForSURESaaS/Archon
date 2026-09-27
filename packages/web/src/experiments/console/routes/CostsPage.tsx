import { useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { elapsedSince, formatCost, formatElapsed, shortRunId } from '../lib/format';
import * as skill from '../skills';
import type { Run } from '../primitives/run';
import { runDisplayText } from '../primitives/run';

type Range = '24h' | '7d' | '30d' | 'all';
const RANGE_MS: Record<Exclude<Range, 'all'>, number> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

const paid = (run: Run): run is Run & { costUsd: number } =>
  typeof run.costUsd === 'number' && Number.isFinite(run.costUsd);

export function selectCostRuns(
  data: Run[],
  cutoff: number
): { requests: Run[]; metered: (Run & { costUsd: number })[]; unmeteredCount: number } {
  const requests = data.filter(run => {
    const startedAt = Date.parse(run.startedAt);
    return run.parentRunId == null && Number.isFinite(startedAt) && startedAt >= cutoff;
  });
  const metered = requests.filter(paid);
  return { requests, metered, unmeteredCount: requests.length - metered.length };
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

export function CostsPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [range, setRange] = useState<Range>('30d');
  const after = range === 'all' ? undefined : new Date(Date.now() - RANGE_MS[range]).toISOString();
  const { data, loading, error } = useEntity<Run[]>(`${K.costs(projectId)}:${range}`, () =>
    skill.listCostRuns(projectId, after)
  );
  const requests = useMemo(() => {
    const cutoff = range === 'all' ? 0 : Date.now() - RANGE_MS[range];
    // Parent totals already include rolled-up child workflow spend. Reporting only
    // top-level runs keeps one request equal to one billable ledger row.
    return selectCostRuns(data ?? [], cutoff).requests;
  }, [data, range]);
  const runs = useMemo(() => requests.filter(paid), [requests]);
  const unmeteredCount = requests.length - runs.length;
  const total = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const average = runs.length > 0 ? total / runs.length : 0;
  const tokensIn = runs.reduce((sum, run) => sum + (run.tokensIn ?? 0), 0);
  const tokensOut = runs.reduce((sum, run) => sum + (run.tokensOut ?? 0), 0);
  const cacheRead = runs.reduce((sum, run) => sum + (run.cacheReadTokens ?? 0), 0);
  const cacheBase = tokensIn + cacheRead;
  const cacheRate = cacheBase > 0 ? cacheRead / cacheBase : null;
  const completed = runs.filter(run => run.status === 'completed').length;
  const successfulCost = runs
    .filter(run => run.status === 'completed')
    .reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  const byWorkflow = useMemo(() => {
    const groups = new Map<string, { cost: number; count: number }>();
    for (const run of runs) {
      const prior = groups.get(run.workflow) ?? { cost: 0, count: 0 };
      groups.set(run.workflow, { cost: prior.cost + (run.costUsd ?? 0), count: prior.count + 1 });
    }
    return [...groups.entries()]
      .map(([workflow, value]) => ({ workflow, ...value }))
      .sort((a, b) => b.cost - a.cost);
  }, [runs]);
  const maxWorkflowCost = Math.max(0, ...byWorkflow.map(item => item.cost));
  const dailySpend = useMemo(() => {
    const groups = new Map<string, number>();
    for (const run of runs) {
      const day = run.startedAt.slice(0, 10);
      groups.set(day, (groups.get(day) ?? 0) + (run.costUsd ?? 0));
    }
    return [...groups.entries()]
      .map(([day, cost]) => ({ day, cost }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }, [runs]);
  const maxDailyCost = Math.max(0, ...dailySpend.map(item => item.cost));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <ProjectViewTabs projectId={projectId} active="costs" />
        <div className="flex items-center gap-1">
          {(['24h', '7d', '30d', 'all'] as const).map(value => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setRange(value);
              }}
              className={`rounded px-2.5 py-1 font-mono text-xs ${
                range === value
                  ? 'bg-accent text-white'
                  : 'border border-border text-text-secondary hover:bg-surface-hover'
              }`}
            >
              {value.toUpperCase()}
            </button>
          ))}
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto p-4">
        {error ? <div className="text-error">{error.message}</div> : null}
        {loading ? <div className="text-text-secondary">Loading cost telemetry…</div> : null}
        {!loading ? (
          <div className="grid gap-4">
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ['Total spend', formatCost(total)],
                ['Average / request', formatCost(average)],
                ['Cost coverage', `${String(runs.length)}/${String(requests.length)} requests`],
                [
                  'Completed efficiency',
                  runs.length > 0
                    ? `${String(completed)}/${String(runs.length)} · ${formatCost(successfulCost)}`
                    : '—',
                ],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-surface p-4">
                  <div className="text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
                  <div className="mt-2 font-mono text-2xl font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </section>
            {unmeteredCount > 0 ? (
              <p className="text-xs text-text-tertiary">
                {unmeteredCount} request{unmeteredCount === 1 ? '' : 's'} omitted from spend totals
                because the provider did not report a cost.
              </p>
            ) : null}

            <section className="grid gap-3 sm:grid-cols-3">
              {[
                ['Input tokens', formatTokens(tokensIn)],
                ['Output tokens', formatTokens(tokensOut)],
                ['Cache read rate', cacheRate === null ? '—' : `${(cacheRate * 100).toFixed(1)}%`],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-surface px-4 py-3">
                  <div className="text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
                  <div className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </section>

            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="mb-4 text-sm font-semibold">Spend over time</h2>
              {dailySpend.length > 0 ? (
                <div className="flex h-36 items-end gap-1" aria-label="Daily spend">
                  {dailySpend.map(item => (
                    <div
                      key={item.day}
                      className="group relative min-w-1 flex-1 rounded-t bg-accent/75 hover:bg-accent"
                      style={{
                        height: `${String(maxDailyCost > 0 ? Math.max(4, (item.cost / maxDailyCost) * 100) : 4)}%`,
                      }}
                      title={`${item.day}: ${formatCost(item.cost)}`}
                    >
                      <span className="sr-only">
                        {item.day}: {formatCost(item.cost)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-text-secondary">No metered runs in this range.</span>
              )}
            </section>

            <section className="rounded-xl border border-border bg-surface p-4">
              <h2 className="mb-4 text-sm font-semibold">Spend by workflow</h2>
              <div className="grid gap-3">
                {byWorkflow.map(item => (
                  <div
                    key={item.workflow}
                    className="grid grid-cols-[160px_1fr_auto] items-center gap-3"
                  >
                    <span className="truncate font-mono text-xs">{item.workflow}</span>
                    <div className="h-2 overflow-hidden rounded-full bg-surface-elevated">
                      <div
                        className="brand-gradient h-full rounded-full"
                        style={{
                          width: `${String(maxWorkflowCost > 0 ? (item.cost / maxWorkflowCost) * 100 : 0)}%`,
                        }}
                      />
                    </div>
                    <span className="font-mono text-xs tabular-nums text-text-secondary">
                      {formatCost(item.cost)} · {item.count}
                    </span>
                  </div>
                ))}
                {byWorkflow.length === 0 ? (
                  <span className="text-sm text-text-secondary">
                    No metered runs in this range.
                  </span>
                ) : null}
              </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-border bg-surface">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-semibold">Request ledger</h2>
                <p className="text-xs text-text-tertiary">
                  Persisted provider cost per top-level request; child runs and unmetered requests
                  are excluded to prevent double counting.
                </p>
              </div>
              <div className="overflow-x-auto">
                <div className="min-w-[950px]">
                  {runs
                    .slice()
                    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
                    .map(run => (
                      <Link
                        key={run.id}
                        to={`/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(run.id)}`}
                        className="grid grid-cols-[140px_130px_minmax(260px,1fr)_90px_90px_90px_90px] items-center gap-3 border-b border-border/50 px-4 py-3 text-xs last:border-0 hover:bg-surface-hover"
                      >
                        <span className="font-mono">
                          {new Date(run.startedAt).toLocaleString()}
                        </span>
                        <span className="font-mono font-semibold">{run.workflow}</span>
                        <span className="truncate text-text-secondary" title={runDisplayText(run)}>
                          {runDisplayText(run)}
                        </span>
                        <span className={run.status === 'failed' ? 'text-error' : 'text-success'}>
                          {run.status}
                        </span>
                        <span className="font-mono text-text-secondary">
                          {formatElapsed(elapsedSince(run.startedAt, run.finishedAt ?? undefined))}
                        </span>
                        <span className="text-right font-mono text-text-secondary">
                          {formatTokens((run.tokensIn ?? 0) + (run.tokensOut ?? 0))}
                        </span>
                        <span className="text-right font-mono font-semibold tabular-nums">
                          {formatCost(run.costUsd ?? 0)}
                        </span>
                        <span className="sr-only">{shortRunId(run.id)}</span>
                      </Link>
                    ))}
                </div>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
