import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));
const { getJiraIssueRating, listJiraIssueCosts, rateJiraIssue } = await import('./jira-queue');
const codebase = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await db.query('DELETE FROM remote_agent_jira_issue_ratings');
  await db.query('DELETE FROM remote_agent_jira_job_runs');
  await db.query('DELETE FROM remote_agent_jira_jobs');
  await db.query('DELETE FROM remote_agent_workflow_runs');
  await db.query('DELETE FROM remote_agent_conversations');
  await db.query('DELETE FROM remote_agent_codebases');
  await db.query('INSERT INTO remote_agent_codebases (id, name, default_cwd) VALUES ($1, $2, $3)', [
    codebase,
    'test',
    '/tmp/test',
  ]);
  await db.query(
    'INSERT INTO remote_agent_conversations (id, platform_type, platform_conversation_id) VALUES ($1, $2, $3)',
    ['conversation-1', 'web', 'test']
  );
});
afterAll(async () => db.close());

test('persists one rating per issue and recomputes raw spend across job attempts without children', async () => {
  for (const [job, revision] of [
    ['job-1', 'v1'],
    ['job-2', 'v2'],
  ]) {
    await db.query(
      `INSERT INTO remote_agent_jira_jobs (id, codebase_id, issue_id, issue_key, source_revision)
      VALUES ($1, $2, $3, $4, $5)`,
      [job, codebase, 'issue-1', 'TEST-1', revision]
    );
  }
  for (const [id, cost, parent] of [
    ['run-1', 2, null],
    ['run-2', 3, null],
    ['child', 1, 'run-1'],
  ] as const) {
    await db.query(
      `INSERT INTO remote_agent_workflow_runs (id, conversation_id, workflow_name, codebase_id, user_message, metadata, parent_run_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        'conversation-1',
        'deliver',
        codebase,
        'test',
        JSON.stringify({ total_cost_usd: cost }),
        parent,
      ]
    );
  }
  for (const [job, run, role] of [
    ['job-1', 'run-1', 'initial'],
    ['job-2', 'run-2', 'correction'],
    ['job-2', 'child', 'recovery'],
  ]) {
    await db.query(
      `INSERT INTO remote_agent_jira_job_runs (job_id, workflow_run_id, role) VALUES ($1, $2, $3)`,
      [job, run, role]
    );
  }
  expect(await listJiraIssueCosts(codebase)).toMatchObject([
    { issueId: 'issue-1', costUsd: 5, runCount: 2, rating: null },
  ]);
  await rateJiraIssue(codebase, 'issue-1', 'TEST-1', 'minimal_correction');
  await rateJiraIssue(codebase, 'issue-1', 'TEST-1', 'poor');
  expect((await getJiraIssueRating(codebase, 'issue-1'))?.rating).toBe('poor');
  expect(await listJiraIssueCosts(codebase)).toMatchObject([
    { costUsd: 5, runCount: 2, rating: 'poor' },
  ]);
});
