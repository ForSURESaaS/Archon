import type { OpenAPIHono } from '@hono/zod-openapi';
import type { JiraDispatcher } from '../services/jira-dispatcher';
import { registerApiRoutes } from './api';
import { registerJiraRoutes } from './jira';
import { registerJiraAnnouncementRoutes } from './jira-announcements';
import { registerBudgetRoutes } from './budget';

type ApiRouteArgs = Parameters<typeof registerApiRoutes>;

export function registerServerApiRoutes(
  app: OpenAPIHono,
  webAdapter: ApiRouteArgs[1],
  lockManager: ApiRouteArgs[2],
  activePlatforms: ApiRouteArgs[3],
  jiraDispatcher: JiraDispatcher
): void {
  registerApiRoutes(app, webAdapter, lockManager, activePlatforms);
  registerJiraRoutes(app, jiraDispatcher);
  registerJiraAnnouncementRoutes(app);
  registerBudgetRoutes(app);
}
