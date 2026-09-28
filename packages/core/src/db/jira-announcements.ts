import { getDatabase, getDialect } from './connection';

export interface JiraAnnouncementRecord {
  id: string;
  jobId: string;
  issueKey: string;
  transition: string;
  text: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function announcementRow(row: Record<string, unknown>): JiraAnnouncementRecord {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    issueKey: String(row.issue_key),
    transition: String(row.transition),
    text: String(row.text),
    createdAt: timestamp(row.created_at),
    acknowledgedAt: row.acknowledged_at === null ? null : timestamp(row.acknowledged_at),
  };
}

export async function recordJiraAnnouncement(input: {
  jobId: string;
  dedupeKey: string;
  issueKey: string;
  transition: string;
  text: string;
}): Promise<JiraAnnouncementRecord> {
  const db = getDatabase();
  const id = getDialect().generateUuid();
  await db.query(
    `INSERT INTO remote_agent_jira_announcements
       (id, job_id, dedupe_key, issue_key, transition, text)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (job_id, dedupe_key) DO NOTHING`,
    [id, input.jobId, input.dedupeKey, input.issueKey, input.transition, input.text]
  );
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM remote_agent_jira_announcements
      WHERE job_id = $1 AND dedupe_key = $2`,
    [input.jobId, input.dedupeKey]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Jira announcement could not be persisted.');
  return announcementRow(row);
}

export async function listJiraAnnouncements(
  options: {
    includeAcknowledged?: boolean;
    codebaseId?: string;
    limit?: number;
  } = {}
): Promise<JiraAnnouncementRecord[]> {
  const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 50)));
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!options.includeAcknowledged) conditions.push('a.acknowledged_at IS NULL');
  if (options.codebaseId) {
    params.push(options.codebaseId);
    conditions.push(`j.codebase_id = $${String(params.length)}`);
  }
  params.push(limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await getDatabase().query<Record<string, unknown>>(
    `SELECT a.* FROM remote_agent_jira_announcements a
      JOIN remote_agent_jira_jobs j ON j.id = a.job_id
      ${where}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${String(params.length)}`,
    params
  );
  return result.rows.map(announcementRow);
}

export async function acknowledgeJiraAnnouncement(
  id: string
): Promise<JiraAnnouncementRecord | null> {
  const db = getDatabase();
  await db.query(
    `UPDATE remote_agent_jira_announcements
        SET acknowledged_at = COALESCE(acknowledged_at, ${getDialect().now()})
      WHERE id = $1`,
    [id]
  );
  const result = await db.query<Record<string, unknown>>(
    'SELECT * FROM remote_agent_jira_announcements WHERE id = $1',
    [id]
  );
  return result.rows[0] ? announcementRow(result.rows[0]) : null;
}
