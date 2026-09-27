import { afterEach, describe, expect, mock, test } from 'bun:test';
import { listCostRuns } from './runs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('listCostRuns', () => {
  test('paginates until the server total is collected', async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url, 'https://archon.test').searchParams.get('offset'));
      const count = offset === 0 ? 200 : 1;
      const runs = Array.from({ length: count }, (_, index) => ({
        id: `run-${String(offset + index)}`,
        workflow_name: 'deliver',
        codebase_id: 'project-1',
        status: 'completed',
        started_at: '2026-09-27T10:00:00.000Z',
      }));
      return Response.json({ runs, total: 201, counts: {} });
    }) as unknown as typeof fetch;

    const runs = await listCostRuns('project-1', '2026-09-01T00:00:00.000Z');

    expect(runs).toHaveLength(201);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('limit=200');
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=200');
    expect(urls[1]).toContain('after=2026-09-01T00%3A00%3A00.000Z');
  });
});
