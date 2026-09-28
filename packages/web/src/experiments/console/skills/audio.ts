import { requestJson, HttpError } from '../lib/http';
import { getConfig } from './settings';

// Audio endpoints are intentionally owned by this skill so the provisional web
// contract can be swapped for generated API types once backend integration lands.
const AUDIO_BASE = '/api/audio';

export interface AudioConfig {
  enabled: boolean;
  voice: string;
  model: string;
}

export interface SpeechRequest {
  text: string;
  voice?: string;
  announcementId?: string;
}

export interface SpeechResponse {
  audioUrl: string;
}

export interface AudioAnnouncement {
  id: string;
  jobId?: string;
  text: string;
  createdAt: string;
  projectId?: string;
  issueKey?: string;
  transition?: string;
  acknowledgedAt?: string | null;
}

export interface JiraAudioLog extends AudioAnnouncement {
  status: 'pending' | 'played' | 'failed' | 'skipped';
  error?: string | null;
}

export function getAudioConfig(): Promise<AudioConfig> {
  return getConfig().then(response => {
    const audio = (
      response.config as typeof response.config & {
        audio?: { enabled: boolean; provider: 'azure-openai'; model: string; voice: string };
      }
    ).audio;
    return {
      enabled: audio?.enabled ?? true,
      voice: audio?.voice ?? 'coral',
      model: audio?.model ?? 'gpt-audio-mini-global',
    };
  });
}

export async function updateAudioConfig(config: AudioConfig): Promise<AudioConfig> {
  const response = await requestJson<{
    config: {
      audio?: { enabled: boolean; provider: 'azure-openai'; model: string; voice: string };
    };
  }>('/api/config/audio', {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: config.enabled,
      provider: 'azure-openai',
      model: config.model,
      voice: config.voice,
    }),
  });
  return {
    enabled: response.config.audio?.enabled ?? config.enabled,
    voice: response.config.audio?.voice ?? config.voice,
    model: response.config.audio?.model ?? config.model,
  };
}

export async function synthesizeSpeech(request: SpeechRequest): Promise<SpeechResponse> {
  const response = await fetch(`${AUDIO_BASE}/speech`, {
    credentials: 'same-origin',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: request.text }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(response.status, `${AUDIO_BASE}/speech`, body.slice(0, 200));
  }
  return { audioUrl: URL.createObjectURL(await response.blob()) };
}

export function getAudioAnnouncements(): Promise<{ announcements: AudioAnnouncement[] }> {
  return requestJson<{ announcements: AudioAnnouncement[] }>('/api/jira/announcements?limit=50');
}

export async function getJiraAudioLogs(projectId: string): Promise<{ logs: JiraAudioLog[] }> {
  const result = await requestJson<{ announcements: AudioAnnouncement[] }>(
    `/api/codebases/${encodeURIComponent(projectId)}/jira/audio-logs`
  );
  return {
    logs: result.announcements.map(item => ({
      ...item,
      status: item.acknowledgedAt ? 'played' : 'pending',
    })),
  };
}

export function acknowledgeAudioAnnouncement(id: string): Promise<AudioAnnouncement> {
  return requestJson<AudioAnnouncement>(`/api/jira/announcements/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
  });
}
