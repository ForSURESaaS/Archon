import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import * as jiraQueueDb from '@archon/core/db/jira-queue';
import * as userDb from '@archon/core/db/users';
import type { JiraDispatcher } from '../services/jira-dispatcher';
import { jiraCredentialsFromEnv } from '../services/jira-client';
import { getAuth } from '../auth';
import {
  jiraConfigResponseSchema,
  jiraConfigUpdateSchema,
  jiraDispatchResponseSchema,
  jiraEnabledUpdateSchema,
  jiraPrCommentsResponseSchema,
  jiraQueueResponseSchema,
  jiraReconcileResponseSchema,
} from './schemas/jira.schemas';

const errorSchema = z.object({ error: z.string() });
const paramsSchema = z.object({ id: z.string().min(1) });
const issueParamsSchema = z.object({ id: z.string().min(1), key: z.string().min(1) });
const jobParamsSchema = z.object({ id: z.string().min(1), jobId: z.string().uuid() });

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
    terminal: ['DONE'],
  },
  automation: { poll_interval_seconds: 60, concurrency: 1 },
  branches: { base: 'main', ticket_pattern: 'archon/{issue_key}' },
  workflow: 'archon-deliver',
};

export function registerJiraRoutes(app: OpenAPIHono, dispatcher: JiraDispatcher): void {
  const resolveUserId = async (request: Request): Promise<string | null> => {
    const auth = getAuth();
    if (auth) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user) {
        return (
          await userDb.findOrCreateUserByPlatformIdentity(
            'web',
            session.user.id,
            session.user.name ?? session.user.email ?? undefined
          )
        ).id;
      }
    }
    const headerName = process.env.ARCHON_WEB_AUTH_HEADER || 'X-Archon-User';
    const identity = request.headers.get(headerName)?.trim();
    if (!identity) return null;
    return (await userDb.findOrCreateUserByPlatformIdentity('web', identity, identity)).id;
  };

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
          config: stored?.config ?? defaultConfig,
          lastError: dispatcher.getLastError(id),
        },
        200
      );
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
      },
    }),
    async c => {
      const { id } = c.req.valid('param');
      const { config } = c.req.valid('json');
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
      await jiraQueueDb.setJiraEnabled(id, enabled, await resolveUserId(c.req.raw));
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
      return c.json({
        issues: snapshot.issues.map(issue => ({
          ...issue,
          job:
            issue.raw.job !== null && typeof issue.raw.job === 'object'
              ? (issue.raw.job as {
                  id: string;
                  status: string;
                  workflowRunId: string | null;
                  branchName: string | null;
                  prUrl: string | null;
                  conflictDetail: string | null;
                })
              : null,
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
        const job = await dispatcher.dispatch(
          id,
          key,
          (await resolveUserId(c.req.raw)) ?? undefined
        );
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
