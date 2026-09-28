import { requestJson } from '../lib/http';

export interface DailyBudgetStatus {
  dayUtc: string;
  limitUsd: number | null;
  creditUsd: number;
  spentUsd: number;
  remainingUsd: number | null;
  exhausted: boolean;
}

export function getDailyBudget(): Promise<DailyBudgetStatus> {
  return requestJson('/api/budget/daily');
}

export function setDailyBudget(limitUsd: number | null): Promise<DailyBudgetStatus> {
  return requestJson('/api/budget/daily', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitUsd }),
  });
}

export function addDailyBudgetCredit(amountUsd: number): Promise<DailyBudgetStatus> {
  return requestJson('/api/budget/daily/credits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountUsd }),
  });
}
