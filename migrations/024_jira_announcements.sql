CREATE TABLE IF NOT EXISTS remote_agent_jira_announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES remote_agent_jira_jobs(id) ON DELETE CASCADE,
  dedupe_key VARCHAR(255) NOT NULL,
  issue_key VARCHAR(255) NOT NULL,
  transition VARCHAR(64) NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(job_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_jira_announcements_pending
  ON remote_agent_jira_announcements(acknowledged_at, created_at);
