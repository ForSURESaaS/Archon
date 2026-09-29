CREATE TABLE IF NOT EXISTS remote_agent_jira_issue_ratings (
  codebase_id UUID NOT NULL REFERENCES remote_agent_codebases(id) ON DELETE CASCADE,
  issue_id VARCHAR(255) NOT NULL,
  issue_key VARCHAR(255) NOT NULL,
  rating VARCHAR(24) NOT NULL CHECK (rating IN ('okay', 'minimal_correction', 'poor')),
  rated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (codebase_id, issue_id)
);
