import { requestJson } from '../lib/http';

export interface JiraQueueConfig {
  url: string;
  project: string;
  board: { id: string | null; name: string | null };
  sprint: { id: string | null; name: string | null; allowed_states: string[] };
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
  automation: { poll_interval_seconds: number; concurrency: number };
  branches: { base: string; ticket_pattern: string };
  workflow: string;
  cost_factors: { okay: number; minimal_correction: number; poor: number };
}

export type JiraIssueRating = 'okay' | 'minimal_correction' | 'poor';

export interface JiraIssueCost {
  issueId: string;
  issueKey: string;
  rating: JiraIssueRating | null;
  ratedAt: string | null;
  costUsd: number | null;
  runCount: number;
  startedAt: string;
  completedAt: string | null;
}

export interface JiraConfigState {
  configured: boolean;
  credentialsConfigured: boolean;
  enabled: boolean;
  runAsUserId: string | null;
  config: JiraQueueConfig;
  lastError: string | null;
}

export interface JiraIssue {
  id: string;
  key: string;
  projectKey: string;
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  updated: string;
  version: string | number | null;
  url: string;
  sourceRevision: string;
  parent: { key: string; summary: string; status: string; issueType: string } | null;
  subtasks: { key: string; summary: string; status: string; issueType: string }[];
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
  job: {
    id: string;
    status: string;
    workflowRunId: string | null;
    branchName: string | null;
    prUrl: string | null;
    conflictDetail: string | null;
    resumeEligibility: {
      eligible: boolean;
      runId: string | null;
      runStatus: string | null;
      reason: string | null;
    };
    telemetry: {
      runStatus: string;
      startedAt: string;
      completedAt: string | null;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
      requestCount: number;
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
    } | null;
  } | null;
}

export interface JiraQueueState {
  issues: JiraIssue[];
  enabled: boolean;
  credentialsConfigured: boolean;
  activeJobs: number;
  concurrency: number;
  lastError: string | null;
}

export interface JiraIssueDetailState {
  issue: Omit<JiraIssue, 'job'>;
  transitions: { id: string; name: string; destination: string }[];
  costs: {
    totalUsd: number;
    attributedUsd: number;
    unattributedUsd: number;
    runCount: number;
    byModel: { model: string; costUsd: number; calls: number }[];
  } | null;
}

const base = (projectId: string): string => `/api/codebases/${encodeURIComponent(projectId)}/jira`;

export function getJiraConfig(projectId: string): Promise<JiraConfigState> {
  return requestJson(`${base(projectId)}/config`);
}

export function saveJiraConfig(
  projectId: string,
  config: JiraQueueConfig
): Promise<JiraConfigState> {
  return requestJson(`${base(projectId)}/config`, {
    method: 'PUT',
    body: JSON.stringify({ config }),
  });
}

export function setJiraEnabled(projectId: string, enabled: boolean): Promise<{ success: boolean }> {
  return requestJson(`${base(projectId)}/enabled`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

export function getJiraIssueCosts(projectId: string): Promise<{ issues: JiraIssueCost[] }> {
  return requestJson(`${base(projectId)}/costs`);
}

export function getJiraIssues(projectId: string): Promise<JiraQueueState> {
  return requestJson(`${base(projectId)}/issues`);
}

export function getJiraIssue(projectId: string, issueKey: string): Promise<JiraIssueDetailState> {
  return requestJson(`${base(projectId)}/issues/${encodeURIComponent(issueKey)}`);
}

export function transitionJiraIssue(
  projectId: string,
  issueKey: string,
  transitionId: string,
  rating?: JiraIssueRating
): Promise<JiraIssueDetailState> {
  return requestJson(`${base(projectId)}/issues/${encodeURIComponent(issueKey)}/transition`, {
    method: 'POST',
    body: JSON.stringify({ transitionId, ...(rating ? { rating } : {}) }),
  });
}

export function dispatchJiraIssue(
  projectId: string,
  issueKey: string
): Promise<{ accepted: boolean; jobId: string; runId: string | null; status: string }> {
  return requestJson(`${base(projectId)}/dispatch/${encodeURIComponent(issueKey)}`, {
    method: 'POST',
  });
}

export function checkJiraPrComments(
  projectId: string,
  issueKey: string
): Promise<{ found: number; dispatched: boolean; runId: string | null }> {
  return requestJson(`${base(projectId)}/pr-comments/${encodeURIComponent(issueKey)}`, {
    method: 'POST',
  });
}

export function reconcileJiraJob(
  projectId: string,
  jobId: string
): Promise<{ jobId: string; runId: string | null; status: string }> {
  return requestJson(`${base(projectId)}/jobs/${encodeURIComponent(jobId)}/reconcile`, {
    method: 'POST',
  });
}

export function retryJiraCorrection(
  projectId: string,
  jobId: string
): Promise<{ found: number; dispatched: boolean; runId: string | null }> {
  return requestJson(`${base(projectId)}/jobs/${encodeURIComponent(jobId)}/retry-correction`, {
    method: 'POST',
  });
}

export function resumeJiraJob(
  projectId: string,
  jobId: string
): Promise<{ jobId: string; runId: string | null; status: string }> {
  return requestJson(`${base(projectId)}/jobs/${encodeURIComponent(jobId)}/resume`, {
    method: 'POST',
  });
}
