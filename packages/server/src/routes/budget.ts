import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addDailyBudgetCredit,
  getDailyBudgetStatus,
  setDailyBudgetLimit,
} from '@archon/core/db/daily-budget';

const budgetStatusSchema = z
  .object({
    dayUtc: z.string(),
    limitUsd: z.number().nonnegative().nullable(),
    creditUsd: z.number().nonnegative(),
    spentUsd: z.number().nonnegative(),
    remainingUsd: z.number().nonnegative().nullable(),
    exhausted: z.boolean(),
  })
  .openapi('DailyBudgetStatus');

export function registerBudgetRoutes(app: OpenAPIHono): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/budget/daily',
      tags: ['System'],
      responses: {
        200: {
          description: 'Current installation-wide UTC daily AI budget',
          content: { 'application/json': { schema: budgetStatusSchema } },
        },
      },
    }),
    async c => c.json(await getDailyBudgetStatus(), 200)
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/budget/daily',
      tags: ['System'],
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({ limitUsd: z.number().nonnegative().nullable() }).strict(),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Updated daily AI budget',
          content: { 'application/json': { schema: budgetStatusSchema } },
        },
      },
    }),
    async c => c.json(await setDailyBudgetLimit(c.req.valid('json').limitUsd), 200)
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/budget/daily/credits',
      tags: ['System'],
      request: {
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z.object({ amountUsd: z.number().positive().max(1_000_000) }).strict(),
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Daily credit added',
          content: { 'application/json': { schema: budgetStatusSchema } },
        },
      },
    }),
    async c => c.json(await addDailyBudgetCredit(c.req.valid('json').amountUsd), 200)
  );
}
