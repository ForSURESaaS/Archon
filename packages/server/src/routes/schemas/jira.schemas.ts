import { z } from '@hono/zod-openapi';

const nullableSelectorSchema = z
  .object({
    id: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
  })
  .strict();

export const jiraQueueConfigSchema = z
  .object({
    url: z.string().url(),
    project: z.string().trim().min(1),
    board: nullableSelectorSchema,
    sprint: nullableSelectorSchema.extend({
      allowed_states: z
        .array(z.enum(['active', 'future', 'closed']))
        .min(1)
        .default(['active', 'future']),
    }),
    ticket_selection: z
      .object({
        issue_types: z.array(z.string().min(1)).default(['Bug', 'Task', 'Story']),
        eligible_statuses: z.array(z.string().min(1)).default(['TO DO']),
        excluded_statuses: z.array(z.string().min(1)).default(['DONE']),
        additional_jql: z.string().default(''),
        order_by: z.array(z.string().min(1)).default(['priority DESC', 'rank ASC', 'created ASC']),
      })
      .strict(),
    workflow_states: z
      .object({
        claimed: z.string().min(1).default('IN PROGRESS'),
        ready_for_manual_test_via: z.array(z.string().min(1)).default([]),
        ready_for_manual_test: z.string().min(1).default('DONE'),
        terminal: z.array(z.string().min(1)).default(['DONE']),
      })
      .strict(),
    automation: z
      .object({
        poll_interval_seconds: z.number().int().min(15).max(3600).default(60),
        concurrency: z.number().int().min(1).max(10).default(1),
      })
      .strict(),
    branches: z
      .object({
        base: z.string().min(1).default('main'),
        ticket_pattern: z.string().min(1).default('archon/{issue_key}'),
      })
      .strict(),
    workflow: z.string().min(1).default('archon-deliver'),
  })
  .strict()
  .openapi('JiraQueueConfig');

export const jiraConfigResponseSchema = z
  .object({
    configured: z.boolean(),
    credentialsConfigured: z.boolean(),
    enabled: z.boolean(),
    runAsUserId: z.string().nullable(),
    config: jiraQueueConfigSchema,
    lastError: z.string().nullable(),
  })
  .openapi('JiraConfigResponse');

export const jiraConfigUpdateSchema = z
  .object({
    config: jiraQueueConfigSchema,
  })
  .strict()
  .openapi('JiraConfigUpdate');

export const jiraEnabledUpdateSchema = z
  .object({ enabled: z.boolean() })
  .strict()
  .openapi('JiraEnabledUpdate');

export const jiraIssueSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    summary: z.string(),
    description: z.string(),
    status: z.string(),
    issueType: z.string(),
    priority: z.string().nullable(),
    labels: z.array(z.string()),
    updated: z.string(),
    url: z.string(),
    sourceRevision: z.string(),
    job: z
      .object({
        id: z.string(),
        status: z.string(),
        workflowRunId: z.string().nullable(),
        branchName: z.string().nullable(),
        prUrl: z.string().nullable(),
        conflictDetail: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi('JiraIssue');

export const jiraQueueResponseSchema = z
  .object({
    issues: z.array(jiraIssueSchema),
    enabled: z.boolean(),
    credentialsConfigured: z.boolean(),
    activeJobs: z.number().int(),
    concurrency: z.number().int(),
    lastError: z.string().nullable(),
  })
  .openapi('JiraQueueResponse');

export const jiraDispatchResponseSchema = z
  .object({
    accepted: z.boolean(),
    jobId: z.string(),
    runId: z.string().nullable(),
    status: z.string(),
  })
  .openapi('JiraDispatchResponse');

export const jiraPrCommentsResponseSchema = z
  .object({
    found: z.number().int().nonnegative(),
    dispatched: z.boolean(),
    runId: z.string().nullable(),
  })
  .openapi('JiraPrCommentsResponse');

export const jiraReconcileResponseSchema = z
  .object({
    jobId: z.string(),
    runId: z.string().nullable(),
    status: z.string(),
  })
  .openapi('JiraReconcileResponse');

export type JiraQueueConfigInput = z.infer<typeof jiraQueueConfigSchema>;
