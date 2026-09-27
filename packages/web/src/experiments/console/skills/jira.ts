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
    terminal: string[];
  };
  automation: { poll_interval_seconds: number; concurrency: number };
  branches: { base: string; ticket_pattern: string };
  workflow: string;
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
  summary: string;
  description: string;
  status: string;
  issueType: string;
  priority: string | null;
  labels: string[];
  updated: string;
  url: string;
  sourceRevision: string;
  job: {
    id: string;
    status: string;
    workflowRunId: string | null;
    branchName: string | null;
    prUrl: string | null;
    conflictDetail: string | null;
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

export function getJiraIssues(projectId: string): Promise<JiraQueueState> {
  return requestJson(`${base(projectId)}/issues`);
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
