import { isRunOwnerAnswering } from '@archon/core/services/run-live-owner';

interface RunningWorkflowRow {
  id: string;
  conversation_id: string;
}

export interface WorkflowLiveness {
  live: RunningWorkflowRow[];
  stale: RunningWorkflowRow[];
}

/**
 * A database `running` status is resumable lifecycle state, not proof that an
 * executor survived. Only the per-run owner handshake proves live execution.
 */
export async function classifyWorkflowLiveness(
  rows: RunningWorkflowRow[],
  ownerAnswering: (runId: string) => Promise<boolean> = isRunOwnerAnswering
): Promise<WorkflowLiveness> {
  const checks = await Promise.all(
    rows.map(async run => ({ run, live: await ownerAnswering(run.id) }))
  );
  return {
    live: checks.filter(check => check.live).map(check => check.run),
    stale: checks.filter(check => !check.live).map(check => check.run),
  };
}
