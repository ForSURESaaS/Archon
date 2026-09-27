import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';
import { ProjectViewTabs } from '../components/ProjectViewTabs';
import { invalidate, useEntity } from '../store/cache';
import * as skill from '../skills';

const STATUSES = ['TO DO', 'IN PROGRESS', 'READY FOR TEST', 'DONE'] as const;

function statusTone(status: string): string {
  if (status === 'IN PROGRESS') return 'border-running/40 bg-running-soft';
  if (status === 'READY FOR TEST') return 'border-warning/40 bg-warning-soft';
  if (status === 'DONE') return 'border-success/40 bg-success-soft';
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
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [prCheckMessage, setPrCheckMessage] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<{ issueKey: string; detail: string } | null>(null);

  useEffect(() => {
    if (configState.data && draft === null) setDraft(configState.data.config);
  }, [configState.data, draft]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      invalidate(queueKey);
    }, 10_000);
    return (): void => {
      window.clearInterval(timer);
    };
  }, [queueKey]);

  const grouped = useMemo(() => {
    const groups = new Map<string, skill.JiraIssue[]>();
    for (const status of STATUSES) groups.set(status, []);
    for (const issue of queueState.data?.issues ?? []) {
      const status = issue.status.toUpperCase();
      groups.set(status, [...(groups.get(status) ?? []), issue]);
    }
    return groups;
  }, [queueState.data]);

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
        ) : (
          <div className="grid min-w-[900px] grid-cols-6 gap-3">
            {STATUSES.map(status => (
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
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-accent-bright"
                        >
                          {issue.key}
                        </a>
                        <p className="mt-1 font-medium">{issue.summary}</p>
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
