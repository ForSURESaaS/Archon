import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  getAudioAnnouncements,
  getAudioConfig,
  getJiraAudioLogs,
  synthesizeSpeech,
  updateAudioConfig,
} from './audio';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(result: unknown): ReturnType<typeof mock> {
  const fetchMock = mock(async () => new Response(JSON.stringify(result), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('audio skill endpoints', () => {
  test('keeps config and speech paths isolated', async () => {
    const fetchMock = mockFetch({
      config: { audio: { enabled: true, voice: 'alloy' } },
      database: 'sqlite',
    });
    await getAudioConfig();
    await updateAudioConfig({ enabled: true, voice: 'alloy', model: 'tts' });
    await synthesizeSpeech({ text: 'hello' });

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/config',
      '/api/config/audio',
      '/api/audio/speech',
    ]);
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('PATCH');
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe('POST');
  });

  test('encodes announcement cursors and Jira project ids', async () => {
    const fetchMock = mockFetch({ announcements: [], logs: [] });
    await getAudioAnnouncements();
    await getJiraAudioLogs('owner/repo');
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/jira/announcements?limit=50',
      '/api/codebases/owner%2Frepo/jira/audio-logs',
    ]);
  });
});
