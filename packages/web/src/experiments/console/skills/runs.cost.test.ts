import { afterEach, describe, expect, mock, test } from 'bun:test';
import { listCostRuns } from './runs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('listCostRuns', () => {
  test('aggregates priced input/output/cache separately, retaining reported totals for legacy nodes', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/dashboard/runs')) {
        return Response.json({
          runs: [
            {
              id: 'run-1',
              workflow_name: 'deliver',
              codebase_id: 'project-1',
              status: 'completed',
              started_at: '2026-09-27T10:00:00.000Z',
              metadata: { total_cost_usd: 0.75 },
            },
          ],
          total: 1,
          counts: {},
        });
      }
      return Response.json({
        run: {
          id: 'run-1',
          workflow_name: 'deliver',
          codebase_id: 'project-1',
          status: 'completed',
          started_at: '2026-09-27T10:00:00.000Z',
        },
        events: [
          {
            id: 'e1',
            workflow_run_id: 'run-1',
            event_type: 'node_completed',
            step_name: 'first',
            created_at: '2026-09-27T10:00:00.000Z',
            data: {
              binding: { model: { requested: 'azure-openai-responses/gpt-6-sol' } },
              cost_usd: 0.5,
              tokens: {
                input: 1100,
                output: 100,
                cacheRead: 800,
                cacheWrite: 100,
                costBreakdown: { input: 0.2, output: 0.2, cacheRead: 0.05, cacheWrite: 0.05 },
              },
            },
          },
          {
            id: 'e2',
            workflow_run_id: 'run-1',
            event_type: 'node_failed',
            step_name: 'legacy',
            created_at: '2026-09-27T10:01:00.000Z',
            data: {
              binding: { model: { requested: 'azure-openai-responses/gpt-6-sol' } },
              cost_usd: 0.25,
              tokens: { input: 400, output: 40, cacheRead: 300, cacheWrite: 50 },
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const [run] = await listCostRuns('project-1');
    expect(run.costUsd).toBe(0.75);
    expect(run.modelCosts).toEqual([
      {
        model: 'azure-openai-responses/gpt-6-sol',
        calls: 2,
        costUsd: 0.75,
        tokensIn: 1500,
        tokensOut: 140,
        cacheRead: 1100,
        cacheWrite: 150,
        inputCostUsd: null,
        outputCostUsd: null,
        cacheReadCostUsd: null,
        cacheWriteCostUsd: null,
        partial: false,
      },
    ]);
  });
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
