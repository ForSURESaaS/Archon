import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { SqliteAdapter, sqliteDialect } from './adapters/sqlite';

const db = new SqliteAdapter(':memory:');
mock.module('./connection', () => ({
  pool: db,
  getDatabase: () => db,
  getDialect: () => sqliteDialect,
  getDatabaseType: () => 'sqlite',
}));

const { acknowledgeJiraAnnouncement, listJiraAnnouncements, recordJiraAnnouncement } =
  await import('./jira-announcements');

const jobId = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  await db.query('DELETE FROM remote_agent_jira_announcements');
  await db.query('DELETE FROM remote_agent_jira_jobs');
  await db.query('DELETE FROM remote_agent_codebases');
  await db.query(
    `INSERT INTO remote_agent_codebases (id, name, default_cwd)
     VALUES ($1, $2, $3)`,
    ['22222222-2222-4222-8222-222222222222', 'test', '/tmp/test']
  );
  await db.query(
    `INSERT INTO remote_agent_jira_jobs
       (id, codebase_id, issue_id, issue_key, source_revision)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, '22222222-2222-4222-8222-222222222222', 'issue-1', 'FS-1', 'rev-1']
  );
});

afterAll(async () => db.close());

describe('Jira announcements', () => {
  test('deduplicates transition effects and lists only pending rows by default', async () => {
    const input = {
      jobId,
      dedupeKey: 'completed:run-1',
      issueKey: 'FS-1',
      transition: 'READY',
      text: 'FS-1 moved to READY.',
    };
    const first = await recordJiraAnnouncement(input);
    const duplicate = await recordJiraAnnouncement({ ...input, text: 'changed text' });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.text).toBe(input.text);
    expect(await listJiraAnnouncements()).toHaveLength(1);

    const acknowledged = await acknowledgeJiraAnnouncement(first.id);
    expect(acknowledged?.acknowledgedAt).not.toBeNull();
    expect(await listJiraAnnouncements()).toEqual([]);
    expect(await listJiraAnnouncements({ includeAcknowledged: true })).toHaveLength(1);
  });

  test('returns null when acknowledging an unknown row', async () => {
    expect(await acknowledgeJiraAnnouncement('33333333-3333-4333-8333-333333333333')).toBeNull();
  });
});
