import { z } from '@hono/zod-openapi';

export const jiraAnnouncementSchema = z
  .object({
    id: z.string().uuid(),
    jobId: z.string().uuid(),
    issueKey: z.string(),
    transition: z.string(),
    text: z.string(),
    createdAt: z.string(),
    acknowledgedAt: z.string().nullable(),
  })
  .openapi('JiraAnnouncement');

export const jiraAnnouncementListSchema = z
  .object({ announcements: z.array(jiraAnnouncementSchema) })
  .openapi('JiraAnnouncementList');
