import type { OpenAPIHono } from '@hono/zod-openapi';
import type { JiraDispatcher } from '../services/jira-dispatcher';
import { registerApiRoutes } from './api';
import { registerJiraRoutes } from './jira';

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
}
