import { afterEach, describe, expect, mock, test } from 'bun:test';
import { JiraClient, jiraCredentialsFromEnv } from './jira-client';
import type { JiraQueueConfig } from '@archon/core/db/jira-queue';

const config: JiraQueueConfig = {
  url: 'https://jira.example',
  project: 'APP',
  board: { id: null, name: 'Delivery' },
  sprint: { id: '123', name: 'Example Sprint', allowed_states: ['future'] },
  ticket_selection: {
    issue_types: ['Task'],
    eligible_statuses: ['TO DO'],
    excluded_statuses: ['DONE'],
    additional_jql: 'labels = archon',
    order_by: ['priority DESC'],
  },
  workflow_states: {
    claimed: 'IN PROGRESS',
    ready_for_manual_test_via: [],
    ready_for_manual_test: 'READY FOR TEST',
    terminal: ['DONE'],
  },
  automation: { poll_interval_seconds: 60, concurrency: 1 },
  branches: { base: 'main', ticket_pattern: 'archon/{issue_key}' },
  workflow: 'archon-deliver',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('JiraClient', () => {
  test('credentials are environment-only and require both values', () => {
    expect(
      jiraCredentialsFromEnv({ JIRA_EMAIL: 'me@example.com', JIRA_API_TOKEN: 'secret' })
    ).toEqual({ email: 'me@example.com', apiToken: 'secret' });
    expect(jiraCredentialsFromEnv({ JIRA_EMAIL: 'me@example.com' })).toBeNull();
    expect(jiraCredentialsFromEnv({ JIRA_API_TOKEN: 'secret' })).toEqual({
      email: null,
      apiToken: 'secret',
    });
  });

  test('constructs bounded queue JQL', () => {
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    expect(client.buildQueueJql(config, '42')).toBe(
      'project = "APP" AND sprint = 42 AND issuetype in ("Task") AND status in ("TO DO") AND status not in ("DONE") AND (labels = archon) ORDER BY priority DESC'
    );
  });

  test('quotes sprint names but not numeric sprint IDs', () => {
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    expect(client.buildQueueJql(config, 'Example Sprint')).toContain('sprint = "Example Sprint"');
    expect(client.buildQueueJql(config, '123')).toContain('sprint = 123');
  });

  test('rejects ambiguous exact board matches', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        values: [
          { id: 1, name: 'Delivery' },
          { id: 2, name: 'Delivery' },
        ],
        isLast: true,
      })
    ) as unknown as typeof fetch;
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    await expect(client.resolveBoard(config)).rejects.toThrow('ambiguous');
  });

  test('discovers transition IDs by destination status', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return new Response(null, { status: 204 });
      return Response.json({
        transitions: [{ id: '31', name: 'Start', to: { name: 'IN PROGRESS' } }],
      });
    }) as unknown as typeof fetch;
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    await client.transitionIssue('APP-1', 'IN PROGRESS');
    expect(calls[1]?.init?.body).toBe('{"transition":{"id":"31"}}');
  });

  test('prefers an exact transition name when destinations are duplicated', async () => {
    let postedBody: RequestInit['body'];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postedBody = init.body;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        transitions: [
          { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
          { id: '4', name: 'Started', to: { name: 'In Progress' } },
        ],
      });
    }) as unknown as typeof fetch;
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    await client.transitionIssue('APP-1', 'IN PROGRESS');
    expect(postedBody).toBe('{"transition":{"id":"21"}}');
  });

  test('retries scoped tokens through the Atlassian cloud gateway', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const value = String(url);
      urls.push(value);
      if (value.endsWith('/_edge/tenant_info')) {
        return Response.json({ cloudId: 'cloud-123' });
      }
      if (value.startsWith('https://example.atlassian.net/')) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
      }
      return Response.json({ transitions: [] });
    }) as unknown as typeof fetch;
    const client = new JiraClient('https://example.atlassian.net', {
      email: 'e',
      apiToken: 'scoped-token',
    });
    await expect(client.transitionIssue('APP-1', 'IN PROGRESS')).rejects.toThrow(
      "No Jira transition to 'IN PROGRESS'"
    );
    expect(urls).toContain(
      'https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/issue/APP-1/transitions?expand=transitions.fields'
    );
  });

  test('uses Bearer authentication for token-only scoped credentials', async () => {
    const authorizations: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/_edge/tenant_info')) return Response.json({ cloudId: 'cloud-123' });
      authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
      if (value.startsWith('https://example.atlassian.net/')) {
        return Response.json({ message: 'Unauthorized' }, { status: 401 });
      }
      return Response.json({ transitions: [] });
    }) as unknown as typeof fetch;
    const client = new JiraClient('https://example.atlassian.net', {
      email: null,
      apiToken: 'scoped-token',
    });
    await expect(client.transitionIssue('APP-1', 'IN PROGRESS')).rejects.toThrow(
      "No Jira transition to 'IN PROGRESS'"
    );
    expect(authorizations).toEqual(['Bearer scoped-token', 'Bearer scoped-token']);
  });

  test('treats an already-reached transition destination as success', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes('/transitions?')) return Response.json({ transitions: [] });
      return Response.json({ fields: { status: { name: 'MANUAL TEST' } } });
    }) as unknown as typeof fetch;
    const client = new JiraClient('https://example.atlassian.net', {
      email: 'e',
      apiToken: 'classic-token',
    });

    await expect(client.transitionIssue('APP-1', 'MANUAL TEST')).resolves.toBeUndefined();
  });

  test('adds a marked Jira comment only once', async () => {
    const methods: string[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (init?.method === 'POST') return Response.json({});
      return Response.json({
        comments: [
          {
            body: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '[marker]' }] }],
            },
          },
        ],
        total: 1,
      });
    }) as unknown as typeof fetch;
    const client = new JiraClient('https://example.invalid', {
      email: 'e',
      apiToken: 'classic-token',
    });

    await expect(client.addCommentOnce('APP-1', '[marker]', 'done')).resolves.toBe(false);
    expect(methods).toEqual(['GET']);
  });

  test('prefers Bearer gateway when an email is also configured', async () => {
    const requests: { url: string; authorization: string }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith('/_edge/tenant_info')) return Response.json({ cloudId: 'cloud-123' });
      requests.push({
        url: value,
        authorization: new Headers(init?.headers).get('Authorization') ?? '',
      });
      return Response.json({ issues: [], isLast: true });
    }) as unknown as typeof fetch;
    const client = new JiraClient('https://example.atlassian.net', {
      email: 'me@example.com',
      apiToken: 'scoped-token',
    });
    await client.searchIssues('project = "APP"');
    expect(requests).toEqual([
      {
        url: expect.stringContaining('https://api.atlassian.com/ex/jira/cloud-123/'),
        authorization: 'Bearer scoped-token',
      },
    ]);
  });

  test('paginates Jira search and keeps stable issue identity', async () => {
    let page = 0;
    globalThis.fetch = mock(async () => {
      page += 1;
      return Response.json({
        issues: [
          {
            id: String(page),
            key: `APP-${page.toString()}`,
            fields: {
              summary: `Issue ${page.toString()}`,
              status: { name: 'TO DO' },
              issuetype: { name: 'Task' },
              updated: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
        total: 2,
        startAt: page - 1,
        maxResults: 1,
      });
    }) as unknown as typeof fetch;
    const client = new JiraClient(config.url, { email: 'e', apiToken: 't' });
    const issues = await client.searchIssues('project = "APP"');
    expect(issues.map(issue => issue.id)).toEqual(['1', '2']);
    expect(issues[0]?.sourceRevision).toMatch(/^sha256:/);
  });
});
