import { describe, expect, test } from 'bun:test';
import type { Run } from '../primitives/run';
import {
  aggregateTokenUsage,
  cacheReadRate,
  effectiveTicketCost,
  selectCostRuns,
  selectTickets,
} from './CostsPage';
import type { JiraIssueCost } from '../skills/jira';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    projectId: 'project-1',
    projectName: 'Project',
    costUsd: 1,
    tokensIn: 10,
    tokensOut: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    conversationId: null,
    conversationPlatformId: null,
    workerPlatformId: null,
    workflow: 'deliver',
    origin: 'web',
    status: 'completed',
    outcome: null,
    startedAt: '2026-09-27T10:00:00.000Z',
    finishedAt: '2026-09-27T10:01:00.000Z',
    workingPath: null,
    userMessage: 'Ship it',
    activeNodes: [],
    parentRunId: null,
    ...overrides,
  };
}

describe('selectCostRuns', () => {
  test('excludes child runs to avoid rolled-up cost double counting', () => {
    const result = selectCostRuns(
      [run(), run({ id: 'child', parentRunId: 'run-1', costUsd: 0.5 })],
      0
    );

    expect(result.requests.map(item => item.id)).toEqual(['run-1']);
    expect(result.metered).toHaveLength(1);
  });

  test('keeps unmetered requests in coverage but omits them from spend', () => {
    const result = selectCostRuns([run(), run({ id: 'unmetered', costUsd: null })], 0);

    expect(result.requests).toHaveLength(2);
    expect(result.metered.map(item => item.id)).toEqual(['run-1']);
    expect(result.unmeteredCount).toBe(1);
  });

  test('excludes malformed and out-of-range timestamps', () => {
    const result = selectCostRuns(
      [
        run(),
        run({ id: 'malformed', startedAt: 'not-a-date' }),
        run({ id: 'old', startedAt: '2026-09-20T10:00:00.000Z' }),
      ],
      Date.parse('2026-09-26T00:00:00.000Z')
    );

    expect(result.requests.map(item => item.id)).toEqual(['run-1']);
  });
});

test('cache read rate divides cached tokens by gross input without counting them twice', () => {
  expect(cacheReadRate(1000, 800)).toBe(0.8);
  expect(cacheReadRate(0, 0)).toBeNull();
});

describe('ticket cost statistics', () => {
  const ticket: JiraIssueCost = {
    issueId: 'issue-1',
    issueKey: 'TEST-1',
    rating: 'minimal_correction',
    ratedAt: '2026-09-27T12:00:00Z',
    costUsd: 4,
    runCount: 3,
    startedAt: '2026-09-24T12:00:00Z',
    completedAt: '2026-09-27T11:00:00Z',
  };
  test('recalculates effective cost using current factors, not persisted factor values', () => {
    expect(effectiveTicketCost(ticket, { okay: 1, minimal_correction: 2, poor: 3 })).toBe(8);
    expect(effectiveTicketCost(ticket, { okay: 1, minimal_correction: 2.5, poor: 4 })).toBe(10);
    expect(
      effectiveTicketCost({ ...ticket, rating: null }, { okay: 1, minimal_correction: 2, poor: 3 })
    ).toBe(4);
    expect(
      effectiveTicketCost({ ...ticket, costUsd: null }, { okay: 1, minimal_correction: 2, poor: 3 })
    ).toBeNull();
  });
  test('filters by selected rating and review date, including unreviewed tickets', () => {
    const unrated = { ...ticket, issueId: 'issue-2', rating: null, ratedAt: null };
    expect(selectTickets([ticket, unrated], Date.parse('2026-09-26T00:00:00Z'), 'rated')).toEqual([
      ticket,
    ]);
    expect(selectTickets([ticket, unrated], Date.parse('2026-09-26T00:00:00Z'), 'unrated')).toEqual(
      [unrated]
    );
    expect(selectTickets([ticket, unrated], 0, 'unrated')).toEqual([unrated]);
  });
});

describe('aggregateTokenUsage', () => {
  test('includes token-only requests that do not report USD cost', () => {
    const requests = selectCostRuns(
      [
        run(),
        run({
          id: 'token-only',
          costUsd: null,
          tokensIn: 20,
          tokensOut: 8,
          cacheReadTokens: 4,
        }),
      ],
      0
    ).requests;

    expect(aggregateTokenUsage(requests)).toEqual({
      tokensIn: 30,
      tokensOut: 13,
      cacheRead: 4,
    });
  });

  test('ignores missing and non-finite token values', () => {
    expect(
      aggregateTokenUsage([
        run({
          tokensIn: null,
          tokensOut: Number.NaN,
          cacheReadTokens: Number.POSITIVE_INFINITY,
        }),
      ])
    ).toEqual({ tokensIn: 0, tokensOut: 0, cacheRead: 0 });
  });
});
