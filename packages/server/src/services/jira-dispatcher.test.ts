import { describe, expect, test } from 'bun:test';
import type { JiraIssue } from './jira-client';
import {
  captureJiraDelivery,
  isJiraDeliveryRoot,
  jiraAnnouncementText,
  workOrder,
} from './jira-dispatcher';

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '100',
    key: 'APP-1',
    projectKey: 'APP',
    summary: 'Parent goal',
    description: 'Parent acceptance criteria',
    status: 'TO DO',
    issueType: 'Task',
    isSubtask: false,
    priority: null,
    labels: [],
    updated: '2026-09-29',
    version: null,
    url: 'https://example.atlassian.net/browse/APP-1',
    parent: null,
    subtasks: [],
    attachments: [],
    sourceRevision: 'parent-revision',
    raw: {},
    ...overrides,
  };
}

describe('parent-owned Jira delivery', () => {
  const child = issue({
    id: '101',
    key: 'APP-2',
    summary: 'Child task',
    description: 'Change shared files',
    issueType: 'Sub-task',
    isSubtask: true,
    parent: {
      key: 'APP-1',
      summary: 'Parent goal',
      status: 'TO DO',
      issueType: 'Task',
    },
    sourceRevision: 'child-revision',
  });
  const parent = issue({
    subtasks: [
      {
        key: child.key,
        summary: child.summary,
        status: child.status,
        issueType: child.issueType,
      },
    ],
  });

  test('only roots can own a delivery', () => {
    expect(isJiraDeliveryRoot(parent)).toBe(true);
    expect(isJiraDeliveryRoot(child)).toBe(false);
    expect(isJiraDeliveryRoot(issue({ ...child, parent: null }))).toBe(false);
  });

  test('fetches full child requirements and fingerprints them with the parent', async () => {
    const getIssue = async (key: string): Promise<JiraIssue> => {
      expect(key).toBe(child.key);
      return child;
    };
    const delivery = await captureJiraDelivery({ getIssue }, parent);
    expect(delivery.children).toEqual([child]);
    expect(delivery.sourceRevision).toMatch(/^sha256:/);
    expect(delivery.sourceRevision).not.toBe(parent.sourceRevision);
    expect((await captureJiraDelivery({ getIssue }, issue())).sourceRevision).toBe(
      'parent-revision'
    );
    expect(
      workOrder(parent, delivery.children, [], { path: '/contract.json', sha256: 'hash' })
    ).toContain('Change shared files');
    expect(
      workOrder(parent, delivery.children, [], { path: '/contract.json', sha256: 'hash' })
    ).toContain('one parent PR');
  });

  test('fails closed when a child is no longer part of the parent', async () => {
    await expect(
      captureJiraDelivery({ getIssue: async () => issue({ ...child, parent: null }) }, parent)
    ).rejects.toThrow('no longer a child');
  });
});

describe('jiraAnnouncementText', () => {
  test('renders deterministic concise runtime, cost, and diff telemetry', () => {
    expect(
      jiraAnnouncementText('FS-42', 'READY FOR TEST', {
        runtimeMs: 125_400,
        costUsd: 1.236,
        diff: { files: 3, additions: 12, deletions: 4 },
      })
    ).toBe(
      'FS-42 moved to READY FOR TEST. Runtime 125 seconds. Cost $1.24. Diff 3 files, plus 12, minus 4.'
    );
  });

  test('uses stable unknown markers for unavailable telemetry', () => {
    expect(
      jiraAnnouncementText('FS-42', 'DONE', {
        runtimeMs: null,
        costUsd: null,
        diff: null,
      })
    ).toBe('FS-42 moved to DONE. Runtime unknown. Cost unknown. Diff unknown.');
  });
});
import type { JiraJobRecord } from '@archon/core/db/jira-queue';
import type { WorkflowRun, WorkflowRunStatus } from '@archon/workflows/schemas/workflow-run';
import {
  jiraResumeEligibility,
  resumeJiraJob,
  type JiraResumeDependencies,
} from './jira-dispatcher';

function job(overrides: Partial<JiraJobRecord> = {}): JiraJobRecord {
  return {
    id: 'job-1',
    codebaseId: 'codebase-1',
    issueId: '10001',
    issueKey: 'TEST-1',
    sourceRevision: 'revision-1',
    status: 'failed',
    workflowRunId: 'ancestor-run',
    branchName: 'archon/test-1',
    prUrl: null,
    conflictDetail: 'previous failure',
    metadata: {},
    completionPending: false,
    completedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function run(id: string, status: WorkflowRunStatus): WorkflowRun {
  return {
    id,
    workflow_name: 'archon-deliver',
    conversation_id: 'conversation-1',
    parent_conversation_id: null,
    codebase_id: 'codebase-1',
    status,
    outcome: null,
    user_message: 'deliver',
    metadata: {},
    started_at: new Date('2026-09-28T00:00:00.000Z'),
    completed_at: status === 'running' ? null : new Date('2026-09-28T00:01:00.000Z'),
    last_activity_at: null,
    working_path: '/tmp/worktree',
    user_id: 'user-1',
    parent_run_id: null,
    adopted_from_run_id: id === 'leaf-run' ? 'ancestor-run' : null,
    output_root: '/tmp/output',
    checkout_baseline: null,
  };
}

function dependencies(options: {
  leafStatus: WorkflowRunStatus;
  ownerAnswering?: boolean;
  resumed?: boolean;
}): {
  deps: JiraResumeDependencies;
  updates: Parameters<JiraResumeDependencies['updateJob']>[1][];
  failedRuns: string[];
  resumedRuns: string[];
} {
  let storedJob = job();
  let leaf = run('leaf-run', options.leafStatus);
  const updates: Parameters<JiraResumeDependencies['updateJob']>[1][] = [];
  const failedRuns: string[] = [];
  const resumedRuns: string[] = [];
  return {
    updates,
    failedRuns,
    resumedRuns,
    deps: {
      getJob: async jobId => (jobId === storedJob.id ? storedJob : null),
      reconcileLineage: async () => leaf.id,
      getRun: async runId => (runId === leaf.id ? leaf : null),
      isOwnerAnswering: async () => options.ownerAnswering ?? false,
      failRun: async runId => {
        failedRuns.push(runId);
        leaf = run(runId, 'failed');
      },
      resumeRun: async resumedRun => {
        resumedRuns.push(resumedRun.id);
        return options.resumed ?? true;
      },
      updateJob: async (_jobId, update) => {
        updates.push(update);
        storedJob = {
          ...storedJob,
          status: update.status ?? storedJob.status,
          workflowRunId:
            update.workflowRunId === undefined ? storedJob.workflowRunId : update.workflowRunId,
          conflictDetail:
            update.conflictDetail === undefined ? storedJob.conflictDetail : update.conflictDetail,
          metadata: update.metadata ?? storedJob.metadata,
          completionPending: update.completionPending ?? storedJob.completionPending,
          completedAt: update.clearCompleted ? null : storedJob.completedAt,
        };
      },
    },
  };
}

describe('Jira resume eligibility', () => {
  test('uses the reconciled lineage leaf instead of the stale job pointer', async () => {
    const { deps } = dependencies({ leafStatus: 'failed' });

    expect(await jiraResumeEligibility('codebase-1', 'job-1', deps)).toEqual({
      eligible: true,
      runId: 'leaf-run',
      runStatus: 'failed',
      reason: null,
    });
  });

  test('permits only failed or orphaned-running leaves', async () => {
    const orphaned = dependencies({ leafStatus: 'running' });
    expect((await jiraResumeEligibility('codebase-1', 'job-1', orphaned.deps)).eligible).toBe(true);

    const active = dependencies({ leafStatus: 'running', ownerAnswering: true });
    expect(await jiraResumeEligibility('codebase-1', 'job-1', active.deps)).toMatchObject({
      eligible: false,
      runStatus: 'running',
      reason: expect.stringContaining('active execution owner'),
    });

    const completed = dependencies({ leafStatus: 'completed' });
    expect(await jiraResumeEligibility('codebase-1', 'job-1', completed.deps)).toMatchObject({
      eligible: false,
      runStatus: 'completed',
      reason: expect.stringContaining("'completed'"),
    });
  });
});

describe('resumeJiraJob', () => {
  test('resumes the failed leaf and immediately restores monitoring state', async () => {
    const { deps, updates, resumedRuns } = dependencies({ leafStatus: 'failed' });

    const resumed = await resumeJiraJob('codebase-1', 'job-1', 'admin-1', deps);

    expect(resumedRuns).toEqual(['leaf-run']);
    expect(updates).toEqual([
      expect.objectContaining({
        status: 'running',
        workflowRunId: 'leaf-run',
        conflictDetail: null,
        completionPending: false,
        clearCompleted: true,
      }),
    ]);
    expect(resumed).toMatchObject({
      status: 'running',
      workflowRunId: 'leaf-run',
      conflictDetail: null,
      completedAt: null,
    });
  });

  test('terminalizes an orphaned-running leaf before using normal resume semantics', async () => {
    const { deps, failedRuns, resumedRuns } = dependencies({ leafStatus: 'running' });

    await resumeJiraJob('codebase-1', 'job-1', undefined, deps);

    expect(failedRuns).toEqual(['leaf-run']);
    expect(resumedRuns).toEqual(['leaf-run']);
  });

  test('does not clear the Jira failure when the shared resume refuses', async () => {
    const { deps, updates } = dependencies({ leafStatus: 'failed', resumed: false });

    await expect(resumeJiraJob('codebase-1', 'job-1', undefined, deps)).rejects.toThrow(
      'could not be resumed'
    );
    expect(updates).toEqual([]);
  });
});
