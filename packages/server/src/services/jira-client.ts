import { createHash } from 'crypto';
import type { JiraQueueConfig } from '@archon/core/db/jira-queue';

export interface JiraCredentials {
  email: string | null;
  apiToken: string;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface JiraRelatedIssue {
  key: string;
  summary: string;
  status: string;
  issueType: string;
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
  parent: JiraRelatedIssue | null;
  subtasks: JiraRelatedIssue[];
  attachments: JiraAttachment[];
  sourceRevision: string;
  raw: Record<string, unknown>;
}

interface JiraPage<T> {
  values?: T[];
  issues?: T[];
  comments?: T[];
  isLast?: boolean;
  total?: number;
  startAt?: number;
  maxResults?: number;
  nextPageToken?: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: { name?: string };
}

interface JiraComment {
  body?: unknown;
}

function jiraDocumentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(jiraDocumentText).join('');
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return `${typeof record.text === 'string' ? record.text : ''}${jiraDocumentText(record.content)}`;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string
  ) {
    super(message);
  }
}

export function jiraCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): JiraCredentials | null {
  const apiToken = env.JIRA_API_TOKEN?.trim();
  if (!apiToken) return null;
  return { email: env.JIRA_EMAIL?.trim() || null, apiToken };
}

/**
 * Credentials may only be sent to Atlassian Cloud or an operator-approved
 * self-hosted Jira base URL. Exact allowlisting prevents a caller who can edit
 * queue configuration from turning the shared Jira token into an SSRF primitive.
 */
export function assertAllowedJiraBaseUrl(
  value: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const normalized = value.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Jira URL must not contain credentials, a query, or a fragment.');
  }

  const isAtlassianCloud =
    url.protocol === 'https:' &&
    (url.pathname === '' || url.pathname === '/') &&
    url.hostname.toLowerCase().endsWith('.atlassian.net');
  const allowed = (env.JIRA_ALLOWED_BASE_URLS ?? '')
    .split(',')
    .map(item => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!isAtlassianCloud && !allowed.includes(normalized)) {
    throw new Error(
      'Jira URL is not allowed. Use an https://*.atlassian.net site or add the exact base URL to JIRA_ALLOWED_BASE_URLS.'
    );
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentRevision(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(adfText).filter(Boolean).join('\n');
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    return adfText(record.content);
  }
  return '';
}

function quoteJql(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sprintJqlOperand(value: string): string {
  // Jira treats sprint IDs as numbers. Quoting a numeric ID turns it into a sprint
  // name lookup and silently returns no issues, while names still need quoting.
  return /^\d+$/.test(value) ? value : quoteJql(value);
}

export class JiraClient {
  private readonly siteUrl: string;
  private apiUrl: string;
  private readonly basicAuth: string | null;
  private readonly bearerAuth: string;
  private useBearer = false;

  constructor(url: string, credentials: JiraCredentials) {
    this.siteUrl = assertAllowedJiraBaseUrl(url);
    this.apiUrl = this.siteUrl;
    this.basicAuth = credentials.email
      ? `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString('base64')}`
      : null;
    this.bearerAuth = `Bearer ${credentials.apiToken}`;
  }

  private async rawRequest(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set(
      'Authorization',
      this.useBearer ? this.bearerAuth : (this.basicAuth ?? this.bearerAuth)
    );
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers,
    });
  }

  private async switchToScopedTokenGateway(): Promise<boolean> {
    if (this.apiUrl !== this.siteUrl || !this.siteUrl.endsWith('.atlassian.net')) return false;
    const response = await fetch(`${this.siteUrl}/_edge/tenant_info`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return false;
    const tenant = (await response.json()) as { cloudId?: unknown };
    if (typeof tenant.cloudId !== 'string' || tenant.cloudId.length === 0) return false;
    this.apiUrl = `https://api.atlassian.com/ex/jira/${encodeURIComponent(tenant.cloudId)}`;
    this.useBearer = true;
    return true;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const startedOnGateway = await this.switchToScopedTokenGateway();
    let response = await this.rawRequest(path, init);
    // Prefer the scoped-token gateway for Atlassian Cloud. Some site endpoints
    // answer scoped credentials with a misleading HTTP 200 and empty data, so
    // waiting for a 401 would silently hide queue issues. A classic token can
    // still fall back to site URL + Basic auth.
    if (response.status === 401 && startedOnGateway && this.basicAuth) {
      this.apiUrl = this.siteUrl;
      this.useBearer = false;
      response = await this.rawRequest(path, init);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new JiraApiError(
        `Jira request failed (${response.status.toString()})`,
        response.status,
        detail
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async resolveBoard(config: JiraQueueConfig): Promise<string | null> {
    if (config.board.id) return config.board.id;
    if (!config.board.name) return null;
    const matches: { id: string; name: string }[] = [];
    let startAt = 0;
    while (true) {
      const page = await this.request<JiraPage<{ id: string | number; name: string }>>(
        `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(config.project)}&startAt=${startAt.toString()}&maxResults=50`
      );
      const values = page.values ?? [];
      matches.push(
        ...values
          .filter(item => item.name.toLowerCase() === config.board.name?.toLowerCase())
          .map(item => ({ id: String(item.id), name: item.name }))
      );
      if (page.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Jira board '${config.board.name}' was not found`
          : `Jira board '${config.board.name}' is ambiguous; configure its numeric ID`
      );
    }
    return matches[0]?.id ?? null;
  }

  async resolveSprint(config: JiraQueueConfig, boardId: string | null): Promise<string | null> {
    if (config.sprint.id) return config.sprint.id;
    if (!config.sprint.name) return null;
    if (!boardId) throw new Error('A Jira board is required when selecting a sprint by name');
    const matches: { id: string; name: string }[] = [];
    let startAt = 0;
    const states = config.sprint.allowed_states.join(',');
    while (true) {
      const page = await this.request<
        JiraPage<{ id: string | number; name: string; state: string }>
      >(
        `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?startAt=${startAt.toString()}&maxResults=50&state=${encodeURIComponent(states)}`
      );
      const values = page.values ?? [];
      matches.push(
        ...values
          .filter(item => item.name === config.sprint.name)
          .map(item => ({ id: String(item.id), name: item.name }))
      );
      if (page.isLast !== false || values.length === 0) break;
      startAt += values.length;
    }
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Jira sprint '${config.sprint.name}' was not found in allowed states`
          : `Jira sprint '${config.sprint.name}' is ambiguous; configure its ID`
      );
    }
    return matches[0]?.id ?? null;
  }

  buildQueueJql(config: JiraQueueConfig, sprintId: string | null): string {
    const clauses = [`project = ${quoteJql(config.project)}`];
    if (sprintId) clauses.push(`sprint = ${sprintJqlOperand(sprintId)}`);
    if (config.ticket_selection.issue_types.length > 0) {
      clauses.push(
        `issuetype in (${config.ticket_selection.issue_types.map(quoteJql).join(', ')})`
      );
    }
    if (config.ticket_selection.eligible_statuses.length > 0) {
      clauses.push(
        `status in (${config.ticket_selection.eligible_statuses.map(quoteJql).join(', ')})`
      );
    }
    if (config.ticket_selection.excluded_statuses.length > 0) {
      clauses.push(
        `status not in (${config.ticket_selection.excluded_statuses.map(quoteJql).join(', ')})`
      );
    }
    if (config.ticket_selection.additional_jql.trim()) {
      clauses.push(`(${config.ticket_selection.additional_jql.trim()})`);
    }
    const order = config.ticket_selection.order_by.join(', ');
    return `${clauses.join(' AND ')}${order ? ` ORDER BY ${order}` : ''}`;
  }

  async searchIssues(jql: string): Promise<JiraIssue[]> {
    const issues: Record<string, unknown>[] = [];
    let startAt = 0;
    let nextPageToken: string | undefined;
    while (true) {
      const params = new URLSearchParams({
        jql,
        maxResults: '100',
        fields:
          'summary,description,status,issuetype,priority,labels,updated,version,project,sprint,parent,subtasks,attachment',
      });
      if (nextPageToken) params.set('nextPageToken', nextPageToken);
      else params.set('startAt', startAt.toString());
      const page = await this.request<JiraPage<Record<string, unknown>>>(
        `/rest/api/3/search/jql?${params.toString()}`
      );
      const batch = page.issues ?? [];
      issues.push(...batch);
      if (page.nextPageToken) {
        nextPageToken = page.nextPageToken;
        continue;
      }
      const total = page.total ?? issues.length;
      if (batch.length === 0 || issues.length >= total) break;
      startAt += batch.length;
    }
    return issues.map(raw => this.normalizeIssue(raw));
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(issueKey)) {
      throw new Error('Invalid Jira issue key');
    }
    const params = new URLSearchParams({
      fields:
        'summary,description,status,issuetype,priority,labels,updated,version,project,sprint,parent,subtasks,attachment',
    });
    const raw = await this.request<Record<string, unknown>>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params.toString()}`
    );
    return this.normalizeIssue(raw);
  }

  private normalizeIssue(raw: Record<string, unknown>): JiraIssue {
    const fields =
      raw.fields !== null && typeof raw.fields === 'object'
        ? (raw.fields as Record<string, unknown>)
        : {};
    const readName = (value: unknown): string =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { name?: unknown }).name === 'string'
        ? (value as { name: string }).name
        : '';
    const key = typeof raw.key === 'string' ? raw.key : '';
    const relatedIssue = (value: unknown): JiraRelatedIssue | null => {
      if (value === null || typeof value !== 'object') return null;
      const related = value as Record<string, unknown>;
      const relatedFields =
        related.fields !== null && typeof related.fields === 'object'
          ? (related.fields as Record<string, unknown>)
          : {};
      const relatedKey = typeof related.key === 'string' ? related.key : '';
      if (!relatedKey) return null;
      return {
        key: relatedKey,
        summary: typeof relatedFields.summary === 'string' ? relatedFields.summary : '',
        status: readName(relatedFields.status),
        issueType: readName(relatedFields.issuetype),
      };
    };
    const attachments = Array.isArray(fields.attachment)
      ? fields.attachment.flatMap(value => {
          if (value === null || typeof value !== 'object') return [];
          const item = value as Record<string, unknown>;
          if (typeof item.id !== 'string' && typeof item.id !== 'number') return [];
          return [
            {
              id: String(item.id),
              filename:
                typeof item.filename === 'string' ? item.filename : `attachment-${String(item.id)}`,
              mimeType: typeof item.mimeType === 'string' ? item.mimeType : '',
              size: typeof item.size === 'number' ? item.size : 0,
            },
          ];
        })
      : [];
    return {
      id: typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : '',
      key,
      projectKey:
        fields.project !== null &&
        typeof fields.project === 'object' &&
        typeof (fields.project as { key?: unknown }).key === 'string'
          ? (fields.project as { key: string }).key
          : '',
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      description: adfText(fields.description),
      status: readName(fields.status),
      issueType: readName(fields.issuetype),
      priority: readName(fields.priority) || null,
      labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
      updated: typeof fields.updated === 'string' ? fields.updated : '',
      version:
        typeof fields.version === 'string' || typeof fields.version === 'number'
          ? fields.version
          : null,
      url: `${this.siteUrl}/browse/${encodeURIComponent(key)}`,
      parent: relatedIssue(fields.parent),
      subtasks: Array.isArray(fields.subtasks)
        ? fields.subtasks.flatMap(value => {
            const normalized = relatedIssue(value);
            return normalized ? [normalized] : [];
          })
        : [],
      attachments,
      sourceRevision: contentRevision(raw),
      raw,
    };
  }

  async downloadAttachment(attachmentId: string): Promise<Uint8Array> {
    if (!/^\d+$/.test(attachmentId)) throw new Error('Invalid Jira attachment ID');
    await this.switchToScopedTokenGateway();
    const response = await this.rawRequest(
      `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
      {}
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new JiraApiError(
        `Jira attachment download failed (${response.status.toString()})`,
        response.status,
        detail
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async transitionIssue(issueKey: string, destinationStatus: string): Promise<void> {
    const transitions = await this.listTransitions(issueKey);
    const matches = transitions.filter(
      transition =>
        transition.to?.name?.toLowerCase() === destinationStatus.toLowerCase() ||
        transition.name.toLowerCase() === destinationStatus.toLowerCase()
    );
    const exactNameMatches = matches.filter(
      transition => transition.name.toLowerCase() === destinationStatus.toLowerCase()
    );
    const selected =
      exactNameMatches.length === 1
        ? exactNameMatches[0]
        : matches.length === 1
          ? matches[0]
          : undefined;
    if (!selected) {
      if (matches.length === 0) {
        const issue = await this.request<{ fields?: { status?: { name?: string } } }>(
          `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`
        );
        if (issue.fields?.status?.name?.toLowerCase() === destinationStatus.toLowerCase()) {
          return;
        }
      }
      throw new Error(
        matches.length === 0
          ? `No Jira transition to '${destinationStatus}' is available for ${issueKey}`
          : `Multiple Jira transitions lead to '${destinationStatus}' for ${issueKey}; none has an unambiguous matching transition name`
      );
    }
    await this.request<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: selected.id } }),
    });
  }

  async listTransitions(issueKey: string): Promise<JiraTransition[]> {
    const response = await this.request<{ transitions?: JiraTransition[] }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions?expand=transitions.fields`
    );
    return response.transitions ?? [];
  }

  async transitionIssueById(issueKey: string, transitionId: string): Promise<void> {
    const transitions = await this.listTransitions(issueKey);
    const selected = transitions.find(transition => transition.id === transitionId);
    if (!selected) throw new Error(`Jira transition '${transitionId}' is not currently available`);
    await this.request<unknown>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  async addComment(issueKey: string, body: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: body.slice(0, 30000) }],
            },
          ],
        },
      }),
    });
  }

  async addCommentOnce(issueKey: string, marker: string, body: string): Promise<boolean> {
    let startAt = 0;
    while (true) {
      const page = await this.request<JiraPage<JiraComment>>(
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt.toString()}&maxResults=100`
      );
      const comments = page.comments ?? page.values ?? [];
      if (comments.some(comment => jiraDocumentText(comment.body).includes(marker))) return false;
      if (
        comments.length === 0 ||
        (typeof page.total === 'number' && startAt + comments.length >= page.total)
      ) {
        break;
      }
      startAt += comments.length;
    }
    await this.addComment(issueKey, `${body}\n\n${marker}`);
    return true;
  }
}
