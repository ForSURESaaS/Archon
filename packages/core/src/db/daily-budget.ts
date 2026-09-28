import { getDatabase } from './connection';
import { randomUUID } from 'node:crypto';

export interface DailyBudgetStatus {
  dayUtc: string;
  limitUsd: number | null;
  creditUsd: number;
  spentUsd: number;
  remainingUsd: number | null;
  exhausted: boolean;
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function getDailyBudgetStatus(now = new Date()): Promise<DailyBudgetStatus> {
  const dayUtc = utcDay(now);
  const db = getDatabase();
  const config = await db.query<{ daily_limit_usd: number | null }>(
    'SELECT daily_limit_usd FROM remote_agent_spend_config WHERE id = 1'
  );
  const credits = await db.query<{ amount_usd: number }>(
    'SELECT amount_usd FROM remote_agent_daily_spend_credits WHERE day_utc = $1',
    [dayUtc]
  );
  const spend = await db.query<{ amount_usd: number }>(
    'SELECT amount_usd FROM remote_agent_ai_spend_entries WHERE day_utc = $1',
    [dayUtc]
  );
  const spentUsd = spend.rows.reduce((sum, row) => sum + row.amount_usd, 0);
  const limitRaw = config.rows[0]?.daily_limit_usd;
  const parsedLimit = limitRaw === null || limitRaw === undefined ? null : limitRaw;
  const limitUsd =
    parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : null;
  const creditUsd = credits.rows.reduce((sum, row) => sum + row.amount_usd, 0);
  const allowance = limitUsd === null ? null : limitUsd + creditUsd;
  const remainingUsd = allowance === null ? null : Math.max(0, allowance - spentUsd);
  return {
    dayUtc,
    limitUsd,
    creditUsd,
    spentUsd,
    remainingUsd,
    exhausted: allowance !== null && spentUsd >= allowance,
  };
}

export async function setDailyBudgetLimit(limitUsd: number | null): Promise<DailyBudgetStatus> {
  await getDatabase().query(
    `INSERT INTO remote_agent_spend_config (id, daily_limit_usd)
     VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET daily_limit_usd = $1`,
    [limitUsd]
  );
  return getDailyBudgetStatus();
}

export async function addDailyBudgetCredit(
  amountUsd: number,
  now = new Date()
): Promise<DailyBudgetStatus> {
  await getDatabase().query(
    `INSERT INTO remote_agent_daily_spend_credits (id, day_utc, amount_usd)
     VALUES ($1, $2, $3)`,
    [randomUUID(), utcDay(now), amountUsd]
  );
  return getDailyBudgetStatus(now);
}

export async function recordAiSpend(amountUsd: number, now = new Date()): Promise<void> {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return;
  await getDatabase().query(
    `INSERT INTO remote_agent_ai_spend_entries (id, day_utc, amount_usd)
     VALUES ($1, $2, $3)`,
    [randomUUID(), utcDay(now), amountUsd]
  );
}

export class DailyBudgetExceededError extends Error {
  constructor(readonly status: DailyBudgetStatus) {
    super(
      `Daily AI budget exhausted: $${status.spentUsd.toFixed(2)} spent of $${(
        (status.limitUsd ?? 0) + status.creditUsd
      ).toFixed(2)} available for ${status.dayUtc} UTC. Add credit in Costs or Settings.`
    );
    this.name = 'DailyBudgetExceededError';
  }
}

export async function assertDailyBudgetAvailable(): Promise<void> {
  const status = await getDailyBudgetStatus();
  if (status.exhausted) throw new DailyBudgetExceededError(status);
}
