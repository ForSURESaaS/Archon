import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import * as jiraQueueDb from '@archon/core/db/jira-queue';
import * as workflowDb from '@archon/core/db/workflows';
import * as workflowEventDb from '@archon/core/db/workflow-events';
import * as userDb from '@archon/core/db/users';
import { spawn } from 'bun';
import type { JiraDispatcher } from '../services/jira-dispatcher';
import {
  assertAllowedJiraBaseUrl,
  JiraClient,
  jiraCredentialsFromEnv,
} from '../services/jira-client';
import { getAuth } from '../auth';
import {
  jiraConfigResponseSchema,
  jiraConfigUpdateSchema,
  jiraDispatchResponseSchema,
  jiraEnabledUpdateSchema,
  jiraIssueDetailResponseSchema,
  jiraPrCommentsResponseSchema,
  jiraQueueResponseSchema,
  jiraReconcileResponseSchema,
  jiraTransitionRequestSchema,
} from './schemas/jira.schemas';

const errorSchema = z.object({ error: z.string() });
const paramsSchema = z.object({ id: z.string().min(1) });
const issueParamsSchema = z.object({ id: z.string().min(1), key: z.string().min(1) });
const jobParamsSchema = z.object({ id: z.string().min(1), jobId: z.string().uuid() });

export function jiraAccessDecision(input: {
  identityRequired: boolean;
  hostname: string;
  user: { id: string; role: 'admin' | 'member' } | null;
}): { userId: string } | { error: string; status: 401 | 403 } {
  const loopback =
    input.hostname === '127.0.0.1' || input.hostname === 'localhost' || input.hostname === '::1';
  if (!input.identityRequired && loopback) return { userId: '' };
  if (!input.user) return { error: 'Authentication required', status: 401 };
  if (input.user.role !== 'admin') return { error: 'Administrator access required', status: 403 };
  return { userId: input.user.id };
}

const defaultConfig: jiraQueueDb.JiraQueueConfig = {
  url: 'https://your-domain.atlassian.net',
  project: 'PROJECT',
  board: { id: null, name: null },
  sprint: { id: null, name: null, allowed_states: ['active', 'future'] },
  ticket_selection: {
    issue_types: ['Bug', 'Task', 'Story', 'Subtask', 'Sub-task'],
    eligible_statuses: ['TO DO'],
    excluded_statuses: ['DONE'],
    additional_jql: '',
    order_by: ['priority DESC', 'rank ASC', 'created ASC'],
  },
  workflow_states: {
    claimed: 'IN PROGRESS',
    ready_for_manual_test_via: [],
    ready_for_manual_test: 'DONE',
    done_via: [],
    done: 'DONE',
    terminal: ['DONE'],
  },
  automation: { poll_interval_seconds: 60, concurrency: 1 },
  branches: { base: 'main', ticket_pattern: 'archon/{issue_key}' },
  workflow: 'archon-deliver',
};

function withCompletionDefaults(config: jiraQueueDb.JiraQueueConfig): jiraQueueDb.JiraQueueConfig {
  return {
    ...config,
    workflow_states: {
      ...config.workflow_states,
      done_via: config.workflow_states.done_via ?? [],
      done: config.workflow_states.done ?? 'DEVELOPMENT DONE',
    },
  };
}

interface JiraIssueCosts {
  totalUsd: number;
  attributedUsd: number;
  unattributedUsd: number;
  runCount: number;
  byModel: { model: string; costUsd: number; calls: number }[];
}

interface JiraRunTelemetry {
  runStatus: string;
  startedAt: string;
  completedAt: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  models: {
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    calls: number;
  }[];
  progress: {
    completed: number;
    total: number;
    active: string[];
    etaSeconds: number | null;
  };
  changes: { files: number; additions: number; deletions: number } | null;
}

function readFiniteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function requestedModel(data: Record<string, unknown>): string | null {
  const binding = data.binding;
  if (binding === null || typeof binding !== 'object') return null;
  const model = (binding as Record<string, unknown>).model;
  if (typeof model === 'string') return model;
  if (model === null || typeof model !== 'object') return null;
  const requested = (model as Record<string, unknown>).requested;
  return typeof requested === 'string' && requested.trim() !== '' ? requested : null;
}

function readTokens(data: Record<string, unknown>): { input: number; output: number } {
  const tokens = data.tokens;
  if (tokens === null || typeof tokens !== 'object') return { input: 0, output: 0 };
  const value = tokens as Record<string, unknown>;
  return {
    input: readFiniteNonnegative(value.input) ?? 0,
    output: readFiniteNonnegative(value.output) ?? 0,
  };
}

function terminalNodeIds(events: Awaited<ReturnType<typeof workflowEventDb.listWorkflowEvents>>): {
  completed: Set<string>;
  active: Set<string>;
  durationMs: number;
} {
  const completed = new Set<string>();
  const active = new Set<string>();
  let durationMs = 0;
  for (const event of events) {
    const nodeId = event.step_name;
    if (!nodeId) continue;
    if (event.event_type === 'node_started') active.add(nodeId);
    if (
      event.event_type === 'node_completed' ||
      event.event_type === 'node_failed' ||
      event.event_type === 'node_skipped' ||
      event.event_type === 'node_skipped_prior_success'
    ) {
      completed.add(nodeId);
      active.delete(nodeId);
      durationMs += readFiniteNonnegative(event.data.duration_ms) ?? 0;
    }
  }
  return { completed, active, durationMs };
}

async function readRunChanges(
  workingPath: string | null,
  baseline: unknown
): Promise<{ files: number; additions: number; deletions: number } | null> {
  if (!workingPath || baseline === null || typeof baseline !== 'object') return null;
  const base = baseline as { kind?: unknown; commit?: unknown };
  if (base.kind !== 'git' || typeof base.commit !== 'string') return null;
  const child = spawn({
    cmd: ['git', '-C', workingPath, 'diff', '--numstat', `${base.commit}...HEAD`],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) return null;
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    files++;
    if (added !== '-') additions += Number(added) || 0;
    if (deleted !== '-') deletions += Number(deleted) || 0;
  }
  return { files, additions, deletions };
}

async function getRunTelemetry(runId: string): Promise<JiraRunTelemetry | null> {
  const run = await workflowDb.getWorkflowRun(runId);
  if (!run) return null;
  const events = await workflowEventDb.listWorkflowEvents(runId);
  const models = new Map<
    string,
    { tokensIn: number; tokensOut: number; costUsd: number; calls: number }
  >();
  for (const event of events) {
    if (event.event_type !== 'node_completed') continue;
    const model = requestedModel(event.data);
    if (!model) continue;
    const tokens = readTokens(event.data);
    const prior = models.get(model) ?? { tokensIn: 0, tokensOut: 0, costUsd: 0, calls: 0 };
    prior.tokensIn += tokens.input;
    prior.tokensOut += tokens.output;
    prior.costUsd += readFiniteNonnegative(event.data.cost_usd) ?? 0;
    prior.calls++;
    models.set(model, prior);
  }
  const graph = run.metadata.terminal_graph as { node_ids?: unknown } | undefined;
  const nodeIds =
    graph !== null && typeof graph === 'object' && Array.isArray(graph.node_ids)
      ? graph.node_ids.filter((id: unknown): id is string => typeof id === 'string')
      : [];
  const nodes = terminalNodeIds(events);
  const completed =
    nodeIds.length > 0
      ? nodeIds.filter(nodeId => nodes.completed.has(nodeId)).length
      : nodes.completed.size;
  const total = nodeIds.length > 0 ? nodeIds.length : nodes.completed.size;
  const remaining = Math.max(0, total - completed);
  const elapsedSeconds = Math.max(0, (Date.now() - new Date(run.started_at).getTime()) / 1000);
  const averageSeconds = completed > 0 ? elapsedSeconds / completed : null;
  return {
    runStatus: run.status,
    startedAt: new Date(run.started_at).toISOString(),
    completedAt: run.completed_at === null ? null : new Date(run.completed_at).toISOString(),
    tokensIn: readFiniteNonnegative(run.metadata.total_tokens_in) ?? 0,
    tokensOut: readFiniteNonnegative(run.metadata.total_tokens_out) ?? 0,
    costUsd: readFiniteNonnegative(run.metadata.total_cost_usd) ?? 0,
    models: [...models.entries()].map(([model, values]) => ({ model, ...values })),
    progress: {
      completed,
      total,
      active: [...nodes.active],
      etaSeconds:
        run.status === 'running' && averageSeconds !== null
          ? Math.max(0, Math.round(averageSeconds * remaining))
          : null,
    },
    changes: await readRunChanges(run.working_path, run.checkout_baseline),
  };
}

async function getIssueCosts(jobId: string): Promise<JiraIssueCosts | null> {
  const attachments = await jiraQueueDb.listJiraJobRuns(jobId);
  if (attachments.length === 0) return null;
  let totalUsd = 0;
  let hasTotal = false;
  const byModel = new Map<string, { costUsd: number; calls: number }>();
  for (const attachment of attachments) {
    const run = await workflowDb.getWorkflowRun(attachment.workflowRunId);
    const runCost = readFiniteNonnegative(run?.metadata?.total_cost_usd);
    if (runCost !== null) {
      totalUsd += runCost;
      hasTotal = true;
    }
    for (const event of await workflowEventDb.listWorkflowEvents(attachment.workflowRunId)) {
      if (event.event_type !== 'node_completed') continue;
      const model = requestedModel(event.data);
      const cost = readFiniteNonnegative(event.data.cost_usd);
      if (model === null || cost === null) continue;
      const prior = byModel.get(model) ?? { costUsd: 0, calls: 0 };
      byModel.set(model, { costUsd: prior.costUsd + cost, calls: prior.calls + 1 });
    }
  }
  if (!hasTotal) return null;
  const attributedUsd = [...byModel.values()].reduce((sum, entry) => sum + entry.costUsd, 0);
  return {
    totalUsd,
    attributedUsd,
    unattributedUsd: Math.max(0, totalUsd - attributedUsd),
    runCount: attachments.length,
    byModel: [...byModel.entries()]
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

export function registerJiraRoutes(app: OpenAPIHono, dispatcher: JiraDispatcher): void {
  const authorizedUsers = new WeakMap<Request, string>();
  const resolveUser = async (
    request: Request
  ): Promise<Awaited<ReturnType<typeof userDb.getUserById>> | null> => {
    const auth = getAuth();
    if (auth) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user) {
        return await userDb.findOrCreateUserByPlatformIdentity(
          'web',
          session.user.id,
          session.user.name ?? session.user.email ?? undefined
        );
      }
    }
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const identity = request.headers.get(headerName)?.trim();
    if (!identity) return null;
    return await userDb.findOrCreateUserByPlatformIdentity('web', identity, identity);
  };
  const requireAdmin = async (
    request: Request
  ): Promise<{ userId: string } | { error: string; status: 401 | 403 }> => {
    // Explicit loopback-only solo mode has no identity system and remains
    // operator-controlled. Any non-loopback bind must authenticate an
    // administrator before a route can send the shared Jira credential or
    // mutate automation state.
    const hostname = process.env.HOST || '0.0.0.0';
    const user = await resolveUser(request);
    return jiraAccessDecision({
      identityRequired: Boolean(getAuth() || process.env.ARCHON_WEB_AUTH_HEADER),
      hostname,
      user,
    });
  };

  app.use('/api/codebases/:id/jira/*', async (c, next) => {
    const admin = await requireAdmin(c.req.raw);
    if ('error' in admin) return c.json({ error: admin.error }, admin.status);
    authorizedUsers.set(c.req.raw, admin.userId);
    return next();
  });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/codebases/{id}/jira/config',
      request: { params: paramsSchema },
      responses: {
        200: {
          description: 'Jira queue configuration',
          content: { 'application/json': { schema: jiraConfigResponseSchema } },
        },
      },
    }),
    async c => {
      const { id } = c.req.valid('param');
      const stored = await jiraQueueDb.getJiraConfig(id);
      return c.json(
        {
          configured: stored !== null,
          credentialsConfigured: jiraCredentialsFromEnv() !== null,
          enabled: stored?.enabled ?? false,
          runAsUserId: stored?.runAsUserId ?? null,
          config: stored ? withCompletionDefaults(stored.config) : defaultConfig,
          lastError: dispatcher.getLastError(id),
        },
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/codebases/{id}/jira/issues/{key}',
      request: { params: issueParamsSchema },
      responses: {
        200: {
          description: 'Jira issue detail and currently available transitions',
          content: { 'application/json': { schema: jiraIssueDetailResponseSchema } },
        },
        409: {
          description: 'Jira issue detail could not be loaded',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, key } = c.req.valid('param');
      const config = await jiraQueueDb.getJiraConfig(id);
      const credentials = jiraCredentialsFromEnv();
      if (!config || !credentials)
        return c.json({ error: 'Jira configuration or credentials are unavailable.' }, 409);
      try {
        const client = new JiraClient(config.config.url, credentials);
        const [issue, transitions] = await Promise.all([
          client.getIssue(key),
          client.listTransitions(key),
        ]);
        if (issue.projectKey.toLowerCase() !== config.config.project.toLowerCase()) {
          return c.json({ error: 'Jira issue is outside the configured project.' }, 409);
        }
        const job = (await jiraQueueDb.listJiraJobs(id)).find(item => item.issueKey === key);
        return c.json(
          {
            issue,
            transitions: transitions.map(transition => ({
              id: transition.id,
              name: transition.name,
              destination: transition.to?.name ?? transition.name,
            })),
            costs: job ? await getIssueCosts(job.id) : null,
          },
          200
        );
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/codebases/{id}/jira/issues/{key}/transition',
      request: {
        params: issueParamsSchema,
        body: { content: { 'application/json': { schema: jiraTransitionRequestSchema } } },
      },
      responses: {
        200: {
          description: 'Jira issue transitioned',
          content: { 'application/json': { schema: jiraIssueDetailResponseSchema } },
        },
        409: {
          description: 'Jira issue could not be transitioned',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, key } = c.req.valid('param');
      const { transitionId } = c.req.valid('json');
      const config = await jiraQueueDb.getJiraConfig(id);
      const credentials = jiraCredentialsFromEnv();
      if (!config || !credentials)
        return c.json({ error: 'Jira configuration or credentials are unavailable.' }, 409);
      try {
        const client = new JiraClient(config.config.url, credentials);
        const issueBefore = await client.getIssue(key);
        if (issueBefore.projectKey.toLowerCase() !== config.config.project.toLowerCase()) {
          return c.json({ error: 'Jira issue is outside the configured project.' }, 409);
        }
        await client.transitionIssueById(key, transitionId);
        const [issue, transitions] = await Promise.all([
          client.getIssue(key),
          client.listTransitions(key),
        ]);
        const job = (await jiraQueueDb.listJiraJobs(id)).find(item => item.issueKey === key);
        await dispatcher.configurationChanged(id);
        return c.json(
          {
            issue,
            transitions: transitions.map(transition => ({
              id: transition.id,
              name: transition.name,
              destination: transition.to?.name ?? transition.name,
            })),
            costs: job ? await getIssueCosts(job.id) : null,
          },
          200
        );
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/codebases/{id}/jira/jobs/{jobId}/reconcile',
      request: { params: jobParamsSchema },
      responses: {
        200: {
          description: 'Jira job lineage and completion effects reconciled',
          content: { 'application/json': { schema: jiraReconcileResponseSchema } },
        },
        409: {
          description: 'Jira job could not be reconciled',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, jobId } = c.req.valid('param');
      try {
        const job = await dispatcher.reconcileJob(id, jobId);
        return c.json({ jobId: job.id, runId: job.workflowRunId, status: job.status }, 200);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/codebases/{id}/jira/jobs/{jobId}/retry-correction',
      request: { params: jobParamsSchema },
      responses: {
        200: {
          description: 'Failed PR correction retried',
          content: { 'application/json': { schema: jiraPrCommentsResponseSchema } },
        },
        409: {
          description: 'Failed correction could not be retried',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, jobId } = c.req.valid('param');
      try {
        return c.json(await dispatcher.retryFailedCorrection(id, jobId), 200);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/codebases/{id}/jira/config',
      request: {
        params: paramsSchema,
        body: { content: { 'application/json': { schema: jiraConfigUpdateSchema } } },
      },
      responses: {
        200: {
          description: 'Saved Jira queue configuration',
          content: { 'application/json': { schema: jiraConfigResponseSchema } },
        },
        400: {
          description: 'Jira URL is not permitted',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id } = c.req.valid('param');
      const { config } = c.req.valid('json');
      try {
        config.url = assertAllowedJiraBaseUrl(config.url);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      const previous = await jiraQueueDb.getJiraConfig(id);
      await jiraQueueDb.upsertJiraConfig(
        id,
        config,
        previous?.enabled ?? false,
        previous?.runAsUserId ?? null
      );
      await dispatcher.configurationChanged(id);
      return c.json(
        {
          configured: true,
          credentialsConfigured: jiraCredentialsFromEnv() !== null,
          enabled: previous?.enabled ?? false,
          runAsUserId: previous?.runAsUserId ?? null,
          config,
          lastError: null,
        },
        200
      );
    }
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/codebases/{id}/jira/enabled',
      request: {
        params: paramsSchema,
        body: { content: { 'application/json': { schema: jiraEnabledUpdateSchema } } },
      },
      responses: {
        200: {
          description: 'Automation setting',
          content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
        },
        409: {
          description: 'Configuration required',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id } = c.req.valid('param');
      const { enabled } = c.req.valid('json');
      if (!(await jiraQueueDb.getJiraConfig(id)))
        return c.json({ error: 'Configure Jira first' }, 409);
      const userId = authorizedUsers.get(c.req.raw) ?? '';
      await jiraQueueDb.setJiraEnabled(id, enabled, userId || null);
      return c.json({ success: true }, 200);
    }
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/codebases/{id}/jira/issues',
      request: { params: paramsSchema },
      responses: {
        200: {
          description: 'Configured sprint issues',
          content: { 'application/json': { schema: jiraQueueResponseSchema } },
        },
      },
    }),
    async c => {
      const { id } = c.req.valid('param');
      const snapshot = await dispatcher.getSnapshot(id, true);
      const jobs = await Promise.all(
        snapshot.issues.map(async issue => {
          if (issue.raw.job === null || typeof issue.raw.job !== 'object') return null;
          const job = issue.raw.job as {
            id: string;
            status: string;
            workflowRunId: string | null;
            branchName: string | null;
            prUrl: string | null;
            conflictDetail: string | null;
          };
          return {
            ...job,
            telemetry: job.workflowRunId ? await getRunTelemetry(job.workflowRunId) : null,
          };
        })
      );
      return c.json({
        issues: snapshot.issues.map((issue, index) => ({
          ...issue,
          job: jobs[index] ?? null,
        })),
        enabled: snapshot.enabled,
        credentialsConfigured: snapshot.credentialsConfigured,
        activeJobs: snapshot.activeJobs,
        concurrency: snapshot.concurrency,
        lastError: snapshot.lastError,
      });
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/codebases/{id}/jira/dispatch/{key}',
      request: { params: issueParamsSchema },
      responses: {
        202: {
          description: 'Ticket claimed and dispatched',
          content: { 'application/json': { schema: jiraDispatchResponseSchema } },
        },
        409: {
          description: 'Ticket could not be dispatched',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, key } = c.req.valid('param');
      try {
        const userId = authorizedUsers.get(c.req.raw) ?? '';
        const job = await dispatcher.dispatch(id, key, userId || undefined);
        return c.json(
          {
            accepted: true,
            jobId: job.id,
            runId: job.workflowRunId,
            status: job.status,
          },
          202
        );
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/codebases/{id}/jira/pr-comments/{key}',
      request: { params: issueParamsSchema },
      responses: {
        200: {
          description: 'PR comments checked and correction dispatched if needed',
          content: { 'application/json': { schema: jiraPrCommentsResponseSchema } },
        },
        409: {
          description: 'PR comments could not be checked',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const { id, key } = c.req.valid('param');
      try {
        return c.json(await dispatcher.checkPullRequestComments(id, key), 200);
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
  );
}
