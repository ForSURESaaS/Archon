import { useEffect, useMemo, useState, type ReactElement } from 'react';
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
const tokenValue = (value: number | null): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

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

export function aggregateTokenUsage(runs: Run[]): {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
} {
  return {
    tokensIn: runs.reduce((sum, run) => sum + tokenValue(run.tokensIn), 0),
    tokensOut: runs.reduce((sum, run) => sum + tokenValue(run.tokensOut), 0),
    cacheRead: runs.reduce((sum, run) => sum + tokenValue(run.cacheReadTokens), 0),
  };
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value
  );
}

function formatComponent(usd: number | null): string {
  if (usd === null) return 'not reported';
  if (usd > 0 && usd < 0.0001) return `$${usd.toFixed(8)}`;
  return formatCost(usd);
}

function formatDetailedTokens(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

export function cacheReadRate(grossInput: number, cacheRead: number): number | null {
  return grossInput > 0 ? cacheRead / grossInput : null;
}

export function CostsPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [range, setRange] = useState<Range>('30d');
  const [budget, setBudget] = useState<skill.DailyBudgetStatus | null>(null);
  const [limitInput, setLimitInput] = useState('');
  const [creditInput, setCreditInput] = useState('');
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetSaving, setBudgetSaving] = useState(false);
  useEffect(() => {
    void skill
      .getDailyBudget()
      .then(status => {
        setBudget(status);
        setLimitInput(status.limitUsd === null ? '' : String(status.limitUsd));
      })
      .catch((reason: unknown) => {
        setBudgetError(reason instanceof Error ? reason.message : 'Failed to load daily budget');
      });
  }, []);
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
  // Token telemetry is independent of USD cost availability. Pi and Codex can
  // report usage without reporting a price, so include every top-level request.
  const { tokensIn, tokensOut, cacheRead } = aggregateTokenUsage(requests);
  // tokensIn is gross input and already includes cache reads; adding cacheRead
  // again understated the hit rate by double-counting cached tokens.
  const cacheRate = cacheReadRate(tokensIn, cacheRead);
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
  const byModel = useMemo(() => {
    const groups = new Map<string, NonNullable<Run['modelCosts']>[number]>();
    for (const run of runs) {
      for (const item of run.modelCosts ?? []) {
        const prior = groups.get(item.model);
        if (!prior) {
          groups.set(item.model, { ...item });
          continue;
        }
        const addCost = (left: number | null, right: number | null): number | null =>
          left === null || right === null ? null : left + right;
        groups.set(item.model, {
          model: item.model,
          costUsd: prior.costUsd + item.costUsd,
          calls: prior.calls + item.calls,
          tokensIn: prior.tokensIn + item.tokensIn,
          tokensOut: prior.tokensOut + item.tokensOut,
          cacheRead: prior.cacheRead + item.cacheRead,
          cacheWrite: prior.cacheWrite + item.cacheWrite,
          inputCostUsd: addCost(prior.inputCostUsd, item.inputCostUsd),
          outputCostUsd: addCost(prior.outputCostUsd, item.outputCostUsd),
          cacheReadCostUsd: addCost(prior.cacheReadCostUsd, item.cacheReadCostUsd),
          cacheWriteCostUsd: addCost(prior.cacheWriteCostUsd, item.cacheWriteCostUsd),
          partial: prior.partial || item.partial,
        });
      }
    }
    return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd);
  }, [runs]);
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
                ['Provider-reported spend', formatCost(total)],
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

            <section className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold">Daily AI budget</h2>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Installation-wide UTC day. New model calls stop at the limit; an in-flight call
                    may finish slightly above it.
                  </p>
                </div>
                {budget ? (
                  <div className="text-right font-mono text-sm tabular-nums">
                    <div className={budget.exhausted ? 'text-error' : 'text-success'}>
                      {formatCost(budget.spentUsd)} spent
                    </div>
                    <div className="text-xs text-text-secondary">
                      {budget.limitUsd === null
                        ? 'No limit'
                        : `${formatCost(budget.remainingUsd ?? 0)} remaining · ${formatCost(
                            budget.limitUsd + budget.creditUsd
                          )} available`}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-xs text-text-secondary">
                  Base limit (USD/day)
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={limitInput}
                    onChange={event => {
                      setLimitInput(event.target.value);
                    }}
                    placeholder="Blank = unlimited"
                    className="w-44 rounded border border-border bg-surface-elevated px-2.5 py-1.5 font-mono text-text-primary"
                  />
                </label>
                <button
                  type="button"
                  disabled={budgetSaving}
                  onClick={() => {
                    const value = limitInput.trim() === '' ? null : Number(limitInput);
                    if (value !== null && (!Number.isFinite(value) || value < 0)) {
                      setBudgetError('Enter a non-negative daily limit.');
                      return;
                    }
                    setBudgetSaving(true);
                    setBudgetError(null);
                    void skill
                      .setDailyBudget(value)
                      .then(setBudget)
                      .catch((reason: unknown) => {
                        setBudgetError(reason instanceof Error ? reason.message : 'Update failed');
                      })
                      .finally(() => {
                        setBudgetSaving(false);
                      });
                  }}
                  className="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                  Save limit
                </button>
                <label className="grid gap-1 text-xs text-text-secondary">
                  Add credit for {budget?.dayUtc ?? 'today'} (USD)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={creditInput}
                    onChange={event => {
                      setCreditInput(event.target.value);
                    }}
                    placeholder="10.00"
                    className="w-44 rounded border border-border bg-surface-elevated px-2.5 py-1.5 font-mono text-text-primary"
                  />
                </label>
                <button
                  type="button"
                  disabled={budgetSaving}
                  onClick={() => {
                    const value = Number(creditInput);
                    if (!Number.isFinite(value) || value <= 0) {
                      setBudgetError('Enter a positive credit amount.');
                      return;
                    }
                    setBudgetSaving(true);
                    setBudgetError(null);
                    void skill
                      .addDailyBudgetCredit(value)
                      .then(status => {
                        setBudget(status);
                        setCreditInput('');
                      })
                      .catch((reason: unknown) => {
                        setBudgetError(reason instanceof Error ? reason.message : 'Top-up failed');
                      })
                      .finally(() => {
                        setBudgetSaving(false);
                      });
                  }}
                  className="rounded border border-accent px-3 py-1.5 text-xs font-semibold text-accent disabled:opacity-50"
                >
                  Add today’s credit
                </button>
              </div>
              {budget?.creditUsd ? (
                <p className="mt-2 text-xs text-text-tertiary">
                  Today’s manual credits: {formatCost(budget.creditUsd)}
                </p>
              ) : null}
              {budgetError ? <p className="mt-2 text-xs text-error">{budgetError}</p> : null}
            </section>

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
              <h2 className="mb-4 text-sm font-semibold">Spend by model</h2>
              {byModel.length > 0 ? (
                <div className="overflow-x-auto">
                  <div className="min-w-[1280px] text-xs">
                    <div className="grid grid-cols-[minmax(240px,2fr)_repeat(9,minmax(95px,1fr))] gap-3 border-b border-border pb-2 text-text-tertiary">
                      <span>Model / calls</span>
                      <span>Input tokens</span>
                      <span>Cache read tokens</span>
                      <span>Cache write tokens</span>
                      <span>Uncached input USD</span>
                      <span>Cache read USD</span>
                      <span>Cache write USD</span>
                      <span>Output tokens</span>
                      <span>Output USD</span>
                      <span>Total USD</span>
                    </div>
                    {byModel.map(item => (
                      <div
                        key={item.model}
                        className="grid grid-cols-[minmax(240px,2fr)_repeat(9,minmax(95px,1fr))] gap-3 border-b border-border/50 py-2 font-mono tabular-nums last:border-0"
                      >
                        <span className="break-all">
                          {item.model}{' '}
                          <span className="text-text-tertiary">· {item.calls} billed nodes</span>
                        </span>
                        <span>
                          {formatDetailedTokens(item.tokensIn)}
                          {item.partial ? '*' : ''}
                        </span>
                        <span>
                          {formatDetailedTokens(item.cacheRead)}
                          {item.partial ? '*' : ''}
                        </span>
                        <span>
                          {formatDetailedTokens(item.cacheWrite)}
                          {item.partial ? '*' : ''}
                        </span>
                        <span>{formatComponent(item.inputCostUsd)}</span>
                        <span>{formatComponent(item.cacheReadCostUsd)}</span>
                        <span>{formatComponent(item.cacheWriteCostUsd)}</span>
                        <span>
                          {formatDetailedTokens(item.tokensOut)}
                          {item.partial ? '*' : ''}
                        </span>
                        <span>{formatComponent(item.outputCostUsd)}</span>
                        <span className="font-semibold">{formatCost(item.costUsd)}</span>
                      </div>
                    ))}
                    {total - byModel.reduce((sum, item) => sum + item.costUsd, 0) > 0.000001 ? (
                      <div className="py-2 text-text-secondary">
                        Unattributed/provider roll-up:{' '}
                        {formatCost(total - byModel.reduce((sum, item) => sum + item.costUsd, 0))}
                      </div>
                    ) : null}
                    <p className="pt-2 text-text-tertiary">
                      Input tokens include cache reads and writes. Uncached input, cache reads,
                      cache writes, and output use separate provider-priced USD components. * Some
                      token/cache usage was not reported. Counts are billed nodes, not individual
                      provider API calls. Historic component costs are “not reported”, not
                      estimated.
                    </p>
                  </div>
                </div>
              ) : (
                <span className="text-sm text-text-secondary">
                  No per-model telemetry in this range.
                </span>
              )}
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
                        <span
                          className="text-right font-mono font-semibold tabular-nums"
                          title="Provider-reported total USD; see per-model components above"
                        >
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
