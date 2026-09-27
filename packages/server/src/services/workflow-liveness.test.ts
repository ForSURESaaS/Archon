import { describe, expect, mock, test } from 'bun:test';
import { classifyWorkflowLiveness } from './workflow-liveness';

describe('classifyWorkflowLiveness', () => {
  test('classifies running rows by live-owner handshake, not persisted status', async () => {
    const ownerAnswering = mock(async (runId: string) => runId === 'live-run');
    const result = await classifyWorkflowLiveness(
      [
        { id: 'live-run', conversation_id: 'conversation-live' },
        { id: 'stale-run', conversation_id: 'conversation-stale' },
      ],
      ownerAnswering
    );

    expect(result.live.map(run => run.id)).toEqual(['live-run']);
    expect(result.stale.map(run => run.id)).toEqual(['stale-run']);
    expect(ownerAnswering).toHaveBeenCalledTimes(2);
  });

  test('does not mutate stale rows while reporting them', async () => {
    const row = { id: 'stale-run', conversation_id: 'conversation-stale' };
    const result = await classifyWorkflowLiveness([row], async () => false);

    expect(result).toEqual({ live: [], stale: [row] });
  });
});
