import { pool, getDatabase, getDatabaseType, getDialect } from './connection';
import { lockConfiguredResourceSlot } from './resource-slots';

export function jiraResourceKey(codebaseId: string): string {
  return `jira:${codebaseId}`;
}

export type JiraJobStatus =
  | 'claimed'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'conflicted';

export type JiraIssueRating = 'okay' | 'minimal_correction' | 'poor';

export const DEFAULT_JIRA_COST_FACTORS = {
  okay: 1,
  minimal_correction: 2,
  poor: 3,
} as const;

export interface JiraCostFactors {
  okay: number;
  minimal_correction: number;
  poor: number;
}

export interface JiraQueueConfig {
  url: string;
  project: string;
  board: { id: string | null; name: string | null };
  sprint: {
    id: string | null;
    name: string | null;
    allowed_states: ('active' | 'future' | 'closed')[];
  };
  ticket_selection: {
    issue_types: string[];
    eligible_statuses: string[];
    excluded_statuses: string[];
    additional_jql: string;
    order_by: string[];
  };
  workflow_states: {
    claimed: string;
    ready_for_manual_test_via: string[];
    ready_for_manual_test: string;
    done_via: string[];
    done: string;
    terminal: string[];
  };
  automation: {
    poll_interval_seconds: number;
    concurrency: number;
  };
  branches: {
    base: string;
    ticket_pattern: string;
  };
  workflow: string;
  cost_factors?: JiraCostFactors;
}

export interface JiraIssueRatingRecord {
  issueId: string;
  issueKey: string;
  rating: JiraIssueRating;
  ratedAt: string;
}

export interface JiraIssueCostRecord {
  issueId: string;
  issueKey: string;
  rating: JiraIssueRating | null;
  ratedAt: string | null;
  costUsd: number | null;
  runCount: number;
  startedAt: string;
  completedAt: string | null;
}

export interface JiraConfigRecord {
  codebaseId: string;
  config: JiraQueueConfig;
  enabled: boolean;
  runAsUserId: string | null;
}

export interface JiraJobRecord {
  id: string;
  codebaseId: string;
  issueId: string;
  issueKey: string;
  sourceRevision: string;
  status: JiraJobStatus;
  workflowRunId: string | null;
  branchName: string | null;
  prUrl: string | null;
  conflictDetail: string | null;
  metadata: Record<string, unknown>;
  completionPending: boolean;
  completedAt: string | null;
}

export interface JiraJobRunRecord {
  jobId: string;
  workflowRunId: string;
  predecessorRunId: string | null;
  role: 'initial' | 'correction' | 'recovery';
  attachedAt: string;
}

function parseJson(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value) as unknown;
  return value;
}

function configRow(row: Record<string, unknown>): JiraConfigRecord {
  return {
    codebaseId: String(row.codebase_id),
    config: parseJson(row.config) as JiraQueueConfig,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1',
    runAsUserId: typeof row.run_as_user_id === 'string' ? row.run_as_user_id : null,
  };
}

function jobRow(row: Record<string, unknown>): JiraJobRecord {
  return {
    id: String(row.id),
    codebaseId: String(row.codebase_id),
    issueId: String(row.issue_id),
    issueKey: String(row.issue_key),
    sourceRevision: String(row.source_revision),
    status: String(row.status) as JiraJobStatus,
    workflowRunId: typeof row.workflow_run_id === 'string' ? row.workflow_run_id : null,
    branchName: typeof row.branch_name === 'string' ? row.branch_name : null,
    prUrl: typeof row.pr_url === 'string' ? row.pr_url : null,
    conflictDetail: typeof row.conflict_detail === 'string' ? row.conflict_detail : null,
    metadata: parseJson(row.metadata ?? {}) as Record<string, unknown>,
    completionPending:
      row.completion_pending === true ||
      row.completion_pending === 1 ||
      row.completion_pending === '1',
    completedAt:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : typeof row.completed_at === 'string'
          ? row.completed_at
          : null,
  };
}

export async function getJiraConfig(codebaseId: string): Promise<JiraConfigRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_jira_configs WHERE codebase_id = $1',
    [codebaseId]
  );
  return result.rows[0] ? configRow(result.rows[0]) : null;
}

export async function listEnabledJiraConfigs(): Promise<JiraConfigRecord[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_jira_configs WHERE enabled = $1 ORDER BY codebase_id',
    [true]
  );
  return result.rows.map(configRow);
}

export async function upsertJiraConfig(
  codebaseId: string,
  config: JiraQueueConfig,
  enabled: boolean,
  runAsUserId: string | null
): Promise<void> {
  const dialect = getDialect();
  await getDatabase().withTransaction(async query => {
    await query(
      `INSERT INTO remote_agent_jira_configs (codebase_id, config, enabled, run_as_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (codebase_id) DO UPDATE SET
         config = $2, enabled = $3, run_as_user_id = $4, updated_at = ${dialect.now()}`,
      [codebaseId, JSON.stringify(config), enabled, runAsUserId]
    );
    await lockConfiguredResourceSlot(
      query,
      jiraResourceKey(codebaseId),
      config.automation.concurrency
    );
  });
}

export async function setJiraEnabled(
  codebaseId: string,
  enabled: boolean,
  runAsUserId: string | null
): Promise<void> {
  await pool.query(
    `UPDATE remote_agent_jira_configs
       SET enabled = $2, run_as_user_id = COALESCE($3, run_as_user_id), updated_at = ${getDialect().now()}
     WHERE codebase_id = $1`,
    [codebaseId, enabled, runAsUserId]
  );
}

export async function createJiraJob(input: {
  codebaseId: string;
  issueId: string;
  issueKey: string;
  sourceRevision: string;
  branchName: string;
  metadata: Record<string, unknown>;
}): Promise<JiraJobRecord | null> {
  const existing = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_jira_jobs
      WHERE codebase_id = $1 AND issue_id = $2 AND source_revision = $3`,
    [input.codebaseId, input.issueId, input.sourceRevision]
  );
  const prior = existing.rows[0] ? jobRow(existing.rows[0]) : null;
  // A failed claim is safe to retry only through this explicit dispatch path. Reuse
  // the durable row and clear its terminal run link so the idempotency constraint
  // still prevents two active attempts for the same Jira revision.
  if (prior?.status === 'failed') {
    await pool.query(
      `UPDATE remote_agent_jira_jobs SET
         status = 'claimed', branch_name = $2, metadata = $3,
         workflow_run_id = NULL, pr_url = NULL, conflict_detail = NULL,
         completed_at = NULL, updated_at = ${getDialect().now()}
       WHERE id = $1`,
      [prior.id, input.branchName, JSON.stringify(input.metadata)]
    );
    return getJiraJob(prior.id);
  }
  if (prior) return null;
  const id = getDialect().generateUuid();
  const inserted = await pool.query(
    `INSERT INTO remote_agent_jira_jobs
       (id, codebase_id, issue_id, issue_key, source_revision, branch_name, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (codebase_id, issue_id, source_revision) DO NOTHING`,
    [
      id,
      input.codebaseId,
      input.issueId,
      input.issueKey,
      input.sourceRevision,
      input.branchName,
      JSON.stringify(input.metadata),
    ]
  );
  if (inserted.rowCount === 0) return null;
  return getJiraJob(id);
}

export async function getJiraJob(id: string): Promise<JiraJobRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_jira_jobs WHERE id = $1',
    [id]
  );
  return result.rows[0] ? jobRow(result.rows[0]) : null;
}

export async function attachJiraJobRun(input: {
  jobId: string;
  workflowRunId: string;
  predecessorRunId?: string | null;
  role: JiraJobRunRecord['role'];
}): Promise<void> {
  await getDatabase().withTransaction(async query => {
    await query(
      `INSERT INTO remote_agent_jira_job_runs
         (job_id, workflow_run_id, predecessor_run_id, role)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (workflow_run_id) DO NOTHING`,
      [input.jobId, input.workflowRunId, input.predecessorRunId ?? null, input.role]
    );
    await query(
      `UPDATE remote_agent_jira_jobs
          SET workflow_run_id = $2, updated_at = ${getDialect().now()}
        WHERE id = $1`,
      [input.jobId, input.workflowRunId]
    );
  });
}

export async function listJiraJobRuns(jobId: string): Promise<JiraJobRunRecord[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_jira_job_runs
      WHERE job_id = $1 ORDER BY attached_at, workflow_run_id`,
    [jobId]
  );
  return result.rows.map(row => ({
    jobId: String(row.job_id),
    workflowRunId: String(row.workflow_run_id),
    predecessorRunId: typeof row.predecessor_run_id === 'string' ? row.predecessor_run_id : null,
    role: row.role as JiraJobRunRecord['role'],
    attachedAt:
      row.attached_at instanceof Date ? row.attached_at.toISOString() : String(row.attached_at),
  }));
}

export async function latestCompletedJiraJobRun(jobId: string): Promise<string | null> {
  const result = await pool.query<{ workflow_run_id: string }>(
    `SELECT jr.workflow_run_id
       FROM remote_agent_jira_job_runs jr
       JOIN remote_agent_workflow_runs r ON r.id = jr.workflow_run_id
      WHERE jr.job_id = $1 AND r.status = 'completed'
      ORDER BY r.completed_at DESC, r.started_at DESC, r.id DESC
      LIMIT 1`,
    [jobId]
  );
  return result.rows[0]?.workflow_run_id ?? null;
}

/** Attach adopted descendants and return the newest leaf run for monitoring. */
export async function reconcileJiraJobRunLineage(jobId: string): Promise<string | null> {
  const job = await getJiraJob(jobId);
  if (!job?.workflowRunId) return null;
  let root = job.workflowRunId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 64 && !seen.has(root); depth += 1) {
    seen.add(root);
    const parent = await pool.query<{ adopted_from_run_id: string | null }>(
      'SELECT adopted_from_run_id FROM remote_agent_workflow_runs WHERE id = $1',
      [root]
    );
    const prior = parent.rows[0]?.adopted_from_run_id;
    if (!prior) break;
    root = prior;
  }

  let current = root;
  seen.clear();
  for (let depth = 0; depth < 64 && !seen.has(current); depth += 1) {
    seen.add(current);
    const descendants = await pool.query<{ id: string; status: string }>(
      `SELECT id FROM remote_agent_workflow_runs
        WHERE adopted_from_run_id = $1
        ORDER BY CASE WHEN status = 'completed' THEN 0 ELSE 1 END,
                 started_at DESC, id DESC`,
      [current]
    );
    const next: string | undefined = descendants.rows[0]?.id;
    if (!next) break;
    await attachJiraJobRun({
      jobId,
      workflowRunId: next,
      predecessorRunId: current,
      role: 'recovery',
    });
    current = next;
  }
  return current;
}

export async function getJiraIssueRating(
  codebaseId: string,
  issueId: string
): Promise<JiraIssueRatingRecord | null> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT issue_id, issue_key, rating, rated_at FROM remote_agent_jira_issue_ratings
     WHERE codebase_id = $1 AND issue_id = $2`,
    [codebaseId, issueId]
  );
  const row = result.rows[0];
  return row
    ? {
        issueId: String(row.issue_id),
        issueKey: String(row.issue_key),
        rating: row.rating as JiraIssueRating,
        ratedAt: row.rated_at instanceof Date ? row.rated_at.toISOString() : String(row.rated_at),
      }
    : null;
}

export async function rateJiraIssue(
  codebaseId: string,
  issueId: string,
  issueKey: string,
  rating: JiraIssueRating
): Promise<void> {
  await pool.query(
    `INSERT INTO remote_agent_jira_issue_ratings (codebase_id, issue_id, issue_key, rating)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (codebase_id, issue_id) DO UPDATE SET
       issue_key = EXCLUDED.issue_key, rating = EXCLUDED.rating, rated_at = ${getDialect().now()}`,
    [codebaseId, issueId, issueKey, rating]
  );
}

/** Sum each root workflow once across all jobs/retries for one issue. Costs stay raw in storage. */
export async function listJiraIssueCosts(codebaseId: string): Promise<JiraIssueCostRecord[]> {
  const costField =
    getDatabaseType() === 'postgresql'
      ? "wr.metadata->>'total_cost_usd'"
      : "json_extract(wr.metadata, '$.total_cost_usd')";
  // costField is a fixed dialect-specific expression, never a user-controlled identifier.
  const result = await pool.query<Record<string, unknown>>(
    `SELECT j.issue_id, MAX(j.issue_key) AS issue_key,
            MIN(j.created_at) AS started_at, MAX(j.completed_at) AS completed_at,
            r.rating, r.rated_at,
            COUNT(DISTINCT CASE WHEN wr.parent_run_id IS NULL THEN wr.id END) AS run_count,
            COUNT(CASE WHEN wr.parent_run_id IS NULL AND ${costField} IS NOT NULL
                       THEN 1 END) AS metered_runs,
            SUM(CASE WHEN wr.parent_run_id IS NULL AND ${costField} IS NOT NULL
                     THEN CAST(${costField} AS DOUBLE PRECISION) ELSE 0 END) AS cost_usd
       FROM remote_agent_jira_jobs j
       LEFT JOIN remote_agent_jira_job_runs jr ON jr.job_id = j.id
       LEFT JOIN remote_agent_workflow_runs wr ON wr.id = jr.workflow_run_id
       LEFT JOIN remote_agent_jira_issue_ratings r
         ON r.codebase_id = j.codebase_id AND r.issue_id = j.issue_id
      WHERE j.codebase_id = $1
      GROUP BY j.issue_id, r.rating, r.rated_at`,
    [codebaseId]
  );
  return result.rows.map(row => ({
    issueId: String(row.issue_id),
    issueKey: String(row.issue_key),
    rating: (row.rating as JiraIssueRating | null) ?? null,
    ratedAt:
      row.rated_at instanceof Date
        ? row.rated_at.toISOString()
        : typeof row.rated_at === 'string'
          ? row.rated_at
          : null,
    costUsd: Number(row.metered_runs) > 0 ? Number(row.cost_usd) : null,
    runCount: Number(row.run_count),
    startedAt:
      row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
    completedAt:
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : typeof row.completed_at === 'string'
          ? row.completed_at
          : null,
  }));
}

export async function listJiraJobs(codebaseId: string): Promise<JiraJobRecord[]> {
  const result = await pool.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_jira_jobs WHERE codebase_id = $1 ORDER BY created_at DESC',
    [codebaseId]
  );
  return result.rows.map(jobRow);
}

export async function listJiraJobsWithPullRequests(): Promise<JiraJobRecord[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_jira_jobs
      WHERE pr_url IS NOT NULL AND status IN ('succeeded','conflicted')
      ORDER BY updated_at`
  );
  return result.rows.map(jobRow);
}

export async function listOpenJiraJobs(codebaseId?: string): Promise<JiraJobRecord[]> {
  const params = codebaseId ? [codebaseId] : [];
  const where = codebaseId ? 'codebase_id = $1 AND ' : '';
  const result = await pool.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_jira_jobs
      WHERE ${where}status IN ('claimed','queued','running')
      ORDER BY created_at`,
    params
  );
  return result.rows.map(jobRow);
}

/**
 * Jobs whose linked run can still change their Jira outcome. Failed jobs are
 * included only after that same run has resumed or completed, so a stable failed
 * run is not commented on repeatedly by every monitor pass.
 */
export async function listMonitoredJiraJobs(): Promise<JiraJobRecord[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT j.* FROM remote_agent_jira_jobs j
       LEFT JOIN remote_agent_workflow_runs r ON r.id = j.workflow_run_id
      WHERE j.status IN ('claimed','queued','running')
         OR j.completion_pending = $1
         OR (j.status = 'failed' AND r.status IN ('pending','running','paused','completed'))
      ORDER BY j.created_at`,
    [true]
  );
  return result.rows.map(jobRow);
}

export async function updateJiraJob(
  id: string,
  updates: {
    status?: JiraJobStatus;
    workflowRunId?: string | null;
    prUrl?: string | null;
    conflictDetail?: string | null;
    metadata?: Record<string, unknown>;
    completed?: boolean;
    clearCompleted?: boolean;
    completionPending?: boolean;
  }
): Promise<void> {
  const sets = [`updated_at = ${getDialect().now()}`];
  const values: unknown[] = [id];
  const add = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (updates.status !== undefined) add('status', updates.status);
  if (updates.workflowRunId !== undefined) add('workflow_run_id', updates.workflowRunId);
  if (updates.prUrl !== undefined) add('pr_url', updates.prUrl);
  if (updates.conflictDetail !== undefined) add('conflict_detail', updates.conflictDetail);
  if (updates.metadata !== undefined) add('metadata', JSON.stringify(updates.metadata));
  if (updates.completionPending !== undefined) add('completion_pending', updates.completionPending);
  if (updates.completed) sets.push(`completed_at = ${getDialect().now()}`);
  if (updates.clearCompleted) sets.push('completed_at = NULL');
  await pool.query(`UPDATE remote_agent_jira_jobs SET ${sets.join(', ')} WHERE id = $1`, values);
}
