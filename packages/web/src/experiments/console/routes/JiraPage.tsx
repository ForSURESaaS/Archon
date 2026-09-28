import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { ExternalLink } from 'lucide-react';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { useBackgroundRefresh } from '../lib/background-refresh';
import { elapsedSince, ensureUtc, formatCost, formatElapsed } from '../lib/format';
import { invalidate, useEntity } from '../store/cache';
import * as skill from '../skills';

const ACTIVE_STATUSES = ['TO DO', 'IN PROGRESS', 'MANUAL TEST'] as const;
const ARCHIVE_STATUS = 'DEVELOPMENT DONE';
const ARCHIVE_PAGE_SIZE = 20;

function compactTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function JiraJobTelemetry({
  job,
}: {
  job: NonNullable<skill.JiraIssue['job']>;
}): ReactElement | null {
  const telemetry = job.telemetry;
  const [, tick] = useState(0);
  useEffect(() => {
    if (telemetry?.runStatus !== 'running') return;
    const timer = window.setInterval(() => {
      tick(value => value + 1);
    }, 1_000);
    return (): void => {
      window.clearInterval(timer);
    };
  }, [telemetry?.runStatus]);
  if (!telemetry) return null;
  const progress =
    telemetry.progress.total > 0
      ? Math.min(100, Math.round((telemetry.progress.completed / telemetry.progress.total) * 100))
      : 0;
  const duration = elapsedSince(
    telemetry.startedAt,
    telemetry.completedAt === null ? undefined : telemetry.completedAt
  );
  const modelTitle =
    telemetry.models.length > 0
      ? telemetry.models
          .map(
            model =>
              `${model.model}\n${compactTokens(model.tokensIn)} in / ${compactTokens(model.tokensOut)} out · ${formatCost(model.costUsd)} · ${String(model.calls)} call(s)`
          )
          .join('\n\n')
      : 'No completed model calls yet.';
  return (
    <div className="mt-2 grid gap-2 rounded border border-border/70 bg-surface-elevated p-2 font-mono text-[10px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-secondary">
        <span title={modelTitle}>
          {compactTokens(telemetry.tokensIn)} in · {compactTokens(telemetry.tokensOut)} out
        </span>
        <span title={modelTitle}>{formatCost(telemetry.costUsd)}</span>
        <span title={new Date(ensureUtc(telemetry.startedAt)).toLocaleString()}>
          started {new Date(ensureUtc(telemetry.startedAt)).toLocaleTimeString()}
        </span>
        <span>{formatElapsed(duration)}</span>
        {telemetry.changes ? (
          <span title={`${String(telemetry.changes.files)} changed file(s)`}>
            <span className="text-success">+{telemetry.changes.additions}</span>{' '}
            <span className="text-error">−{telemetry.changes.deletions}</span>
          </span>
        ) : null}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2 text-text-tertiary">
          <span className="truncate">
            {telemetry.progress.active.length > 0
              ? telemetry.progress.active.join(', ')
              : telemetry.runStatus}
          </span>
          <span className="shrink-0">
            {telemetry.progress.completed}/{telemetry.progress.total} · {progress}%
            {telemetry.progress.etaSeconds !== null
              ? ` · ETA ${formatElapsed(telemetry.progress.etaSeconds)}`
              : telemetry.runStatus === 'running'
                ? ' · estimating ETA'
                : ''}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${String(progress)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === 'IN PROGRESS') return 'border-running/40 bg-running-soft';
  if (status === 'MANUAL TEST') return 'border-warning/40 bg-warning-soft';
  if (status === 'DEVELOPMENT DONE' || status === 'ON PRODUCTION')
    return 'border-success/40 bg-success-soft';
  return 'border-border bg-surface-elevated';
}

export function JiraPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const configKey = `jira-config:${projectId}`;
  const queueKey = `jira-queue:${projectId}`;
  const configState = useEntity<skill.JiraConfigState>(configKey, () =>
    skill.getJiraConfig(projectId)
  );
  const queueState = useEntity<skill.JiraQueueState>(queueKey, () =>
    skill.getJiraIssues(projectId)
  );
  const [draft, setDraft] = useState<skill.JiraQueueConfig | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [view, setView] = useState<'active' | 'archive'>('active');
  const [archiveLimit, setArchiveLimit] = useState(ARCHIVE_PAGE_SIZE);
  const archiveSentinelRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prCheckMessage, setPrCheckMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<{ issueKey: string; detail: string } | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<skill.JiraIssueDetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [completionArmed, setCompletionArmed] = useState<string | null>(null);
  const [completionReady, setCompletionReady] = useState(false);

  useEffect(() => {
    if (configState.data && draft === null) setDraft(configState.data.config);
  }, [configState.data, draft]);

  useBackgroundRefresh(() => {
    invalidate(queueKey);
  }, 10_000);

  const grouped = useMemo(() => {
    const groups = new Map<string, skill.JiraIssue[]>();
    for (const issue of queueState.data?.issues ?? []) {
      const status = issue.status.toUpperCase();
      groups.set(status, [...(groups.get(status) ?? []), issue]);
    }
    return groups;
  }, [queueState.data]);

  const archivedIssues = useMemo(
    () =>
      (queueState.data?.issues ?? [])
        .filter(issue => issue.status.toUpperCase() === ARCHIVE_STATUS)
        .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)),
    [queueState.data]
  );
  const visibleArchivedIssues = archivedIssues.slice(0, archiveLimit);

  useEffect(() => {
    setArchiveLimit(ARCHIVE_PAGE_SIZE);
  }, [projectId]);

  useEffect(() => {
    const sentinel = archiveSentinelRef.current;
    if (view !== 'archive' || sentinel === null || archiveLimit >= archivedIssues.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setArchiveLimit(limit => Math.min(limit + ARCHIVE_PAGE_SIZE, archivedIssues.length));
      }
    });
    observer.observe(sentinel);
    return (): void => {
      observer.disconnect();
    };
  }, [view, archiveLimit, archivedIssues.length]);

  const mutate = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setMessage(null);
    setPrCheckMessage(null);
    try {
      await action();
      invalidate(configKey);
      invalidate(queueKey);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openIssue = async (issueKey: string): Promise<void> => {
    setDetailLoading(true);
    setMessage(null);
    try {
      setSelectedIssue(await skill.getJiraIssue(projectId, issueKey));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const transitionIssue = async (issueKey: string, transitionId: string): Promise<void> => {
    setTransitionBusy(true);
    setMessage(null);
    try {
      setSelectedIssue(await skill.transitionJiraIssue(projectId, issueKey, transitionId));
      invalidate(queueKey);
      setCompletionArmed(null);
      setCompletionReady(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTransitionBusy(false);
    }
  };

  useEffect(() => {
    if (completionArmed === null) {
      setCompletionReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setCompletionReady(true);
    }, 2_000);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [completionArmed]);

  if (configState.error) {
    return <div className="p-6 text-error">{configState.error.message}</div>;
  }

  const configured = configState.data?.configured ?? false;
  const credentialsConfigured = configState.data?.credentialsConfigured ?? false;
  const enabled = queueState.data?.enabled ?? configState.data?.enabled ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <ProjectViewTabs projectId={projectId} active="jira" />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="text-text-secondary">
            {queueState.data?.activeJobs ?? 0}/
            {queueState.data?.concurrency ?? draft?.automation.concurrency ?? 1} slots active
          </span>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!configured || busy !== null}
              onChange={event => {
                void mutate('toggle', () => skill.setJiraEnabled(projectId, event.target.checked));
              }}
            />
            Auto-dispatch
          </label>
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 hover:bg-surface-hover"
            onClick={() => {
              setShowConfig(open => !open);
            }}
          >
            {showConfig ? 'Close config' : 'Configure'}
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto p-4">
        <div className="mb-4 flex gap-1 border-b border-border">
          {(['active', 'archive'] as const).map(option => (
            <button
              key={option}
              type="button"
              className={`border-b-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider ${
                view === option
                  ? 'border-accent text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
              onClick={() => {
                setView(option);
              }}
            >
              {option === 'active' ? 'Active board' : 'Completed archive'}
            </button>
          ))}
        </div>
        {!credentialsConfigured ? (
          <div className="mb-4 rounded border border-warning/40 bg-warning-soft p-3 text-sm">
            Set <code>JIRA_API_TOKEN</code> on the Archon server. <code>JIRA_EMAIL</code> is
            required only for classic tokens. Secrets are never stored in this project or sent to
            the browser.
          </div>
        ) : null}
        {message || configState.data?.lastError || queueState.data?.lastError ? (
          <div className="mb-4 rounded border border-error/40 bg-error-soft p-3 text-sm text-error">
            {message ?? queueState.data?.lastError ?? configState.data?.lastError}
          </div>
        ) : null}

        {showConfig && draft ? (
          <section className="mb-4 grid gap-3 rounded border border-border bg-surface-elevated p-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="grid gap-1 text-xs text-text-secondary">
              Jira URL
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-text-primary"
                value={draft.url}
                onChange={event => {
                  setDraft({ ...draft, url: event.target.value });
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Project key
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-text-primary"
                value={draft.project}
                onChange={event => {
                  setDraft({ ...draft, project: event.target.value });
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Board name
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-text-primary"
                value={draft.board.name ?? ''}
                onChange={event => {
                  setDraft({ ...draft, board: { id: null, name: event.target.value || null } });
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Sprint
              <input
                className="rounded border border-border bg-surface px-2 py-1.5 text-text-primary"
                value={draft.sprint.name ?? ''}
                onChange={event => {
                  setDraft({
                    ...draft,
                    sprint: { ...draft.sprint, id: null, name: event.target.value || null },
                  });
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-text-secondary md:col-span-2">
              Concurrency: {draft.automation.concurrency}
              <input
                type="range"
                min={1}
                max={10}
                value={draft.automation.concurrency}
                onChange={event => {
                  setDraft({
                    ...draft,
                    automation: {
                      ...draft.automation,
                      concurrency: Number(event.target.value),
                    },
                  });
                }}
              />
            </label>
            <label className="grid gap-1 text-xs text-text-secondary">
              Poll interval (seconds)
              <input
                type="number"
                min={15}
                max={3600}
                className="rounded border border-border bg-surface px-2 py-1.5 text-text-primary"
                value={draft.automation.poll_interval_seconds}
                onChange={event => {
                  setDraft({
                    ...draft,
                    automation: {
                      ...draft.automation,
                      poll_interval_seconds: Number(event.target.value),
                    },
                  });
                }}
              />
            </label>
            <div className="flex items-end">
              <button
                type="button"
                disabled={busy !== null}
                className="brand-gradient w-full rounded px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                onClick={() => void mutate('save', () => skill.saveJiraConfig(projectId, draft))}
              >
                Save JSON configuration
              </button>
            </div>
            <details className="md:col-span-2 xl:col-span-4">
              <summary className="cursor-pointer text-xs text-text-secondary">
                Advanced JSON
              </summary>
              <textarea
                className="mt-2 h-64 w-full rounded border border-border bg-surface p-3 font-mono text-xs"
                value={JSON.stringify(draft, null, 2)}
                onChange={event => {
                  try {
                    setDraft(JSON.parse(event.target.value) as skill.JiraQueueConfig);
                    setMessage(null);
                  } catch {
                    setMessage('Advanced JSON is not valid yet.');
                  }
                }}
              />
            </details>
          </section>
        ) : null}

        {!configured ? (
          <div className="rounded border border-border bg-surface-elevated p-8 text-center text-text-secondary">
            Configure this project’s reusable Jira sprint to load its queue.
          </div>
        ) : view === 'archive' ? (
          <section className="mx-auto grid w-full max-w-4xl gap-3">
            <header className="flex items-center justify-between text-xs text-text-secondary">
              <span>Newest completed work first</span>
              <span>{archivedIssues.length} completed</span>
            </header>
            {visibleArchivedIssues.map(issue => (
              <article
                key={issue.id}
                className="rounded border border-success/40 bg-surface p-3 text-xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        void openIssue(issue.key);
                      }}
                      className="font-mono text-accent-bright hover:underline"
                    >
                      {issue.key}
                    </button>
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-1 inline-flex text-text-tertiary hover:text-text-primary"
                      title="Open in Jira"
                      aria-label={`Open ${issue.key} in Jira`}
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                    <p className="mt-1 font-medium">{issue.summary}</p>
                  </div>
                  <time className="text-text-tertiary" dateTime={issue.updated}>
                    {new Date(issue.updated).toLocaleString()}
                  </time>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {issue.job?.workflowRunId ? (
                    <Link
                      to={`/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(issue.job.workflowRunId)}`}
                      className="rounded border border-border px-2 py-1"
                    >
                      Archon run
                    </Link>
                  ) : null}
                  {issue.job?.prUrl ? (
                    <a
                      href={issue.job.prUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded border border-border px-2 py-1"
                    >
                      PR
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
            {archivedIssues.length === 0 ? (
              <div className="rounded border border-border bg-surface-elevated p-8 text-center text-text-secondary">
                No development-complete tickets yet.
              </div>
            ) : null}
            <div ref={archiveSentinelRef} className="h-8 text-center text-xs text-text-tertiary">
              {archiveLimit < archivedIssues.length ? 'Loading more…' : 'End of archive'}
            </div>
          </section>
        ) : (
          <div className="grid min-w-[720px] grid-cols-3 gap-3">
            {ACTIVE_STATUSES.map(status => (
              <section key={status} className={`rounded border p-2 ${statusTone(status)}`}>
                <h2 className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider">
                  <span>{status}</span>
                  <span>{grouped.get(status)?.length ?? 0}</span>
                </h2>
                <div className="grid gap-2">
                  {(grouped.get(status) ?? []).map(issue => {
                    const job = issue.job;
                    return (
                      <article
                        key={issue.id}
                        className="rounded border border-border bg-surface p-2 text-xs"
                      >
                        <button
                          type="button"
                          className="font-mono text-accent-bright hover:underline"
                          onClick={() => {
                            void openIssue(issue.key);
                          }}
                        >
                          {issue.key}
                        </button>
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 inline-flex text-text-tertiary hover:text-text-primary"
                          title="Open in Jira"
                          aria-label={`Open ${issue.key} in Jira`}
                        >
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                        <p className="mt-1 font-medium">{issue.summary}</p>
                        {job ? <JiraJobTelemetry job={job} /> : null}
                        {job?.conflictDetail && job.status === 'failed' ? (
                          <button
                            type="button"
                            className="mt-2 flex w-full items-center gap-2 rounded border border-error/30 bg-error-soft px-2 py-1.5 text-left text-error hover:border-error/60"
                            title="Open full error details"
                            onClick={() => {
                              setErrorDetail({
                                issueKey: issue.key,
                                detail: job.conflictDetail ?? '',
                              });
                            }}
                          >
                            <span aria-hidden>!</span>
                            <span className="min-w-0 flex-1 truncate">
                              Archon run needs attention
                            </span>
                            <span className="shrink-0 text-[10px] text-text-tertiary">Details</span>
                          </button>
                        ) : null}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {status === 'TO DO' ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              className="rounded bg-accent px-2 py-1 font-semibold text-white disabled:opacity-50"
                              onClick={() =>
                                void mutate(issue.key, () =>
                                  skill.dispatchJiraIssue(projectId, issue.key)
                                )
                              }
                            >
                              {busy === issue.key ? 'Claiming…' : 'Run'}
                            </button>
                          ) : null}
                          {status === 'MANUAL TEST' ? (
                            <button
                              type="button"
                              disabled={
                                transitionBusy ||
                                (completionArmed === issue.key && !completionReady)
                              }
                              className="rounded bg-success px-2 py-1 font-semibold text-white disabled:opacity-50"
                              onClick={() => {
                                if (completionArmed !== issue.key) {
                                  setCompletionArmed(issue.key);
                                  setCompletionReady(false);
                                  return;
                                }
                                const configuredDone =
                                  configState.data?.config.workflow_states.done ?? ARCHIVE_STATUS;
                                void (async (): Promise<void> => {
                                  const detail = await skill.getJiraIssue(projectId, issue.key);
                                  const transition = detail.transitions.find(
                                    item =>
                                      item.destination.toUpperCase() ===
                                        configuredDone.toUpperCase() ||
                                      item.name.toUpperCase() === configuredDone.toUpperCase()
                                  );
                                  if (!transition) {
                                    setMessage(
                                      `Jira does not currently offer a transition to ${configuredDone}.`
                                    );
                                    setCompletionArmed(null);
                                    return;
                                  }
                                  await transitionIssue(issue.key, transition.id);
                                })();
                              }}
                            >
                              {completionArmed !== issue.key
                                ? 'Mark development done'
                                : completionReady
                                  ? 'Confirm done'
                                  : 'Wait 2 seconds…'}
                            </button>
                          ) : null}
                          {job?.workflowRunId ? (
                            <Link
                              to={`/console/p/${encodeURIComponent(projectId)}/r/${encodeURIComponent(job.workflowRunId)}`}
                              className="rounded border border-border px-2 py-1"
                            >
                              Archon run
                            </Link>
                          ) : null}
                          {job &&
                          job.status !== 'running' &&
                          job.status !== 'queued' &&
                          job.status !== 'claimed' ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              className="rounded border border-border px-2 py-1 hover:bg-surface-hover disabled:opacity-50"
                              onClick={() =>
                                void mutate(`reconcile:${job.id}`, () =>
                                  skill.reconcileJiraJob(projectId, job.id)
                                )
                              }
                            >
                              {busy === `reconcile:${job.id}` ? 'Reconciling…' : 'Reconcile'}
                            </button>
                          ) : null}
                          {job?.status === 'failed' && job.prUrl ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              className="rounded bg-accent px-2 py-1 font-semibold text-white disabled:opacity-50"
                              onClick={() => {
                                const key = `retry:${job.id}`;
                                void mutate(key, async () => {
                                  const result = await skill.retryJiraCorrection(projectId, job.id);
                                  setPrCheckMessage(
                                    `Retry started for ${issue.key} with ${String(result.found)} PR comment(s).`
                                  );
                                });
                              }}
                            >
                              {busy === `retry:${job.id}` ? 'Restarting…' : 'Retry correction'}
                            </button>
                          ) : null}
                          {job?.prUrl ? (
                            <a
                              href={job.prUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded border border-border px-2 py-1"
                            >
                              PR
                            </a>
                          ) : null}
                          {issue.job?.prUrl &&
                          issue.job.status !== 'running' &&
                          issue.job.status !== 'queued' &&
                          issue.job.status !== 'claimed' ? (
                            <button
                              type="button"
                              disabled={busy !== null}
                              className="rounded border border-border px-2 py-1 hover:bg-surface-hover disabled:opacity-50"
                              title={`Automatic checks run every ${String(
                                draft?.automation.poll_interval_seconds ?? 60
                              )} seconds while auto-dispatch is enabled`}
                              onClick={() => {
                                const key = `pr-comments:${issue.key}`;
                                void mutate(key, async () => {
                                  const result = await skill.checkJiraPrComments(
                                    projectId,
                                    issue.key
                                  );
                                  setPrCheckMessage(
                                    result.dispatched
                                      ? `Found ${String(result.found)} new PR comment(s) on ${issue.key}; correction run started and Jira moved to IN PROGRESS.`
                                      : `No new PR comments on ${issue.key}.`
                                  );
                                });
                              }}
                            >
                              {busy === `pr-comments:${issue.key}` ? 'Checking…' : 'Check comments'}
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
      {prCheckMessage ? (
        <div className="fixed bottom-4 right-4 z-50 max-w-md rounded border border-success/40 bg-surface-elevated px-4 py-3 text-sm shadow-xl">
          <div className="flex items-start gap-3">
            <span className="flex-1">{prCheckMessage}</span>
            <button
              type="button"
              className="text-text-secondary hover:text-text-primary"
              aria-label="Dismiss"
              onClick={() => {
                setPrCheckMessage(null);
              }}
            >
              ×
            </button>
          </div>
        </div>
      ) : null}
      {detailLoading ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="rounded border border-border bg-surface-elevated px-6 py-4 text-sm">
            Loading Jira issue…
          </div>
        </div>
      ) : null}
      {selectedIssue ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${selectedIssue.issue.key} Jira details`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            setSelectedIssue(null);
          }}
        >
          <div
            className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-md border border-border bg-surface-elevated shadow-2xl"
            onClick={event => {
              event.stopPropagation();
            }}
          >
            <header className="flex items-start justify-between gap-4 border-b border-border p-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="font-mono text-sm font-semibold text-accent-bright">
                    {selectedIssue.issue.key}
                  </h2>
                  <a
                    href={selectedIssue.issue.url}
                    target="_blank"
                    rel="noreferrer"
                    title="Open in Jira"
                    aria-label={`Open ${selectedIssue.issue.key} in Jira`}
                    className="text-text-tertiary hover:text-text-primary"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                </div>
                <p className="mt-1 text-base font-semibold">{selectedIssue.issue.summary}</p>
              </div>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs"
                onClick={() => {
                  setSelectedIssue(null);
                }}
              >
                Close
              </button>
            </header>
            <div className="grid gap-4 p-4">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded border border-border px-2 py-1">
                  {selectedIssue.issue.status}
                </span>
                <span className="rounded border border-border px-2 py-1">
                  {selectedIssue.issue.issueType}
                </span>
                {selectedIssue.issue.priority ? (
                  <span className="rounded border border-border px-2 py-1">
                    {selectedIssue.issue.priority}
                  </span>
                ) : null}
              </div>
              <section>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  Description
                </h3>
                <p className="whitespace-pre-wrap text-sm text-text-primary">
                  {selectedIssue.issue.description || 'No description supplied.'}
                </p>
              </section>
              {selectedIssue.issue.parent ? (
                <section className="text-xs text-text-secondary">
                  Parent: {selectedIssue.issue.parent.key} · {selectedIssue.issue.parent.summary}
                </section>
              ) : null}
              {selectedIssue.costs ? (
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    Archon cost
                  </h3>
                  <span
                    className="inline-flex cursor-help rounded border border-border px-2 py-1 font-mono text-sm font-semibold tabular-nums"
                    title={[
                      ...selectedIssue.costs.byModel.map(
                        item =>
                          `${item.model}: ${formatCost(item.costUsd)} across ${String(item.calls)} call${item.calls === 1 ? '' : 's'}`
                      ),
                      ...(selectedIssue.costs.unattributedUsd > 0
                        ? [
                            `Unattributed/provider roll-up: ${formatCost(
                              selectedIssue.costs.unattributedUsd
                            )}`,
                          ]
                        : []),
                    ].join('\n')}
                  >
                    {formatCost(selectedIssue.costs.totalUsd)} · {selectedIssue.costs.runCount} run
                    {selectedIssue.costs.runCount === 1 ? '' : 's'}
                  </span>
                  <p className="mt-1 text-xs text-text-tertiary">Hover for spend by model.</p>
                </section>
              ) : null}
              {selectedIssue.issue.subtasks.length > 0 ? (
                <section>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                    Subtasks
                  </h3>
                  <ul className="grid gap-1 text-xs">
                    {selectedIssue.issue.subtasks.map(subtask => (
                      <li key={subtask.key}>
                        {subtask.key} · {subtask.summary} · {subtask.status}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
                  Change Jira state
                </h3>
                <div className="flex flex-wrap gap-2">
                  {selectedIssue.transitions.map(transition => (
                    <button
                      key={transition.id}
                      type="button"
                      disabled={transitionBusy}
                      className="rounded border border-border px-3 py-1.5 text-xs hover:bg-surface-hover disabled:opacity-50"
                      onClick={() => {
                        void transitionIssue(selectedIssue.issue.key, transition.id);
                      }}
                    >
                      {transition.name} → {transition.destination}
                    </button>
                  ))}
                  {selectedIssue.transitions.length === 0 ? (
                    <span className="text-xs text-text-tertiary">
                      No transitions are currently available.
                    </span>
                  ) : null}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : null}
      {errorDetail ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${errorDetail.issueKey} error details`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => {
            setErrorDetail(null);
          }}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-md border border-border bg-surface-elevated shadow-2xl"
            onClick={event => {
              event.stopPropagation();
            }}
          >
            <header className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">
                  {errorDetail.issueKey} · Archon run warning
                </h2>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  The ticket remains in its current Jira stage. See the run for live status.
                </p>
              </div>
              <button
                type="button"
                className="rounded border border-border px-2 py-1 text-xs hover:bg-surface-hover"
                onClick={() => {
                  setErrorDetail(null);
                }}
              >
                Close
              </button>
            </header>
            <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs text-error">
              {errorDetail.detail}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
