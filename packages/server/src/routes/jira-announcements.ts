import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  acknowledgeJiraAnnouncement,
  listJiraAnnouncements,
} from '@archon/core/db/jira-announcements';
import {
  jiraAnnouncementListSchema,
  jiraAnnouncementSchema,
} from './schemas/jira-announcements.schemas';

const errorSchema = z.object({ error: z.string() });

export function registerJiraAnnouncementRoutes(app: OpenAPIHono): void {
  const listRoute = (path: string, scoped: boolean): void => {
    app.openapi(
      createRoute({
        method: 'get',
        path,
        tags: ['Jira'],
        request: {
          ...(scoped ? { params: z.object({ id: z.string().min(1) }) } : {}),
          query: z.object({
            includeAcknowledged: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
          }),
        },
        responses: {
          200: {
            description: 'Jira transition announcements',
            content: { 'application/json': { schema: jiraAnnouncementListSchema } },
          },
        },
      }),
      async c => {
        const query = c.req.valid('query');
        const codebaseId = scoped ? (c.req.param('id') ?? undefined) : undefined;
        const announcements = await listJiraAnnouncements({
          includeAcknowledged: query.includeAcknowledged === 'true',
          codebaseId,
          limit: query.limit,
        });
        return c.json({ announcements }, 200);
      }
    );
  };

  listRoute('/api/jira/announcements', false);
  listRoute('/api/codebases/{id}/jira/audio-logs', true);

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/jira/announcements/{id}/ack',
      tags: ['Jira'],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: {
          description: 'Acknowledged Jira transition announcement',
          content: { 'application/json': { schema: jiraAnnouncementSchema } },
        },
        404: {
          description: 'Announcement not found',
          content: { 'application/json': { schema: errorSchema } },
        },
      },
    }),
    async c => {
      const announcement = await acknowledgeJiraAnnouncement(c.req.valid('param').id);
      if (!announcement) return c.json({ error: 'Announcement not found' }, 404);
      return c.json(announcement, 200);
    }
  );
}
