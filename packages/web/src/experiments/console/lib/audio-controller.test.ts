import { describe, expect, test } from 'bun:test';
import {
  AUDIO_MUTED_KEY,
  AUDIO_VOLUME_KEY,
  announcementSpeechRequest,
  isInterruptedPlayback,
  readAudioPreferences,
  requestSpeechUnlessMuted,
  writeAudioPreferences,
  type AudioStorage,
} from './audio-controller';

function memoryStorage(): AudioStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe('audio preferences', () => {
  test('round-trips muted and volume', () => {
    const storage = memoryStorage();
    writeAudioPreferences(storage, { muted: true, volume: 0.35 });
    expect(storage.values.get(AUDIO_MUTED_KEY)).toBe('true');
    expect(storage.values.get(AUDIO_VOLUME_KEY)).toBe('0.35');
    expect(readAudioPreferences(storage)).toEqual({ muted: true, volume: 0.35 });
  });

  test('defaults to audible volume when no preference has been stored', () => {
    expect(readAudioPreferences(memoryStorage())).toEqual({ muted: false, volume: 1 });
  });

  test('uses a safe default for invalid volume', () => {
    const storage = memoryStorage();
    storage.setItem(AUDIO_VOLUME_KEY, '4');
    expect(readAudioPreferences(storage)).toEqual({ muted: false, volume: 1 });
  });
});

describe('announcement speech', () => {
  test('sends only the short visible snippet to synthesis', () => {
    expect(
      announcementSpeechRequest({
        id: 'announcement-1',
        jobId: 'job-1',
        issueKey: 'FS-42',
        transition: 'done',
        text: 'FS-42 moved to READY. Runtime 30 seconds.',
        createdAt: '2026-09-28T17:00:00Z',
      })
    ).toEqual({
      text: 'FS-42 moved to READY. Runtime 30 seconds.',
      announcementId: 'announcement-1',
    });
  });
});

describe('audio play interruptions', () => {
  test('does not report an interrupted load or pause as failed playback', () => {
    expect(
      isInterruptedPlayback(
        new DOMException('The play() request was interrupted by a new load request.', 'AbortError')
      )
    ).toBe(true);
    expect(isInterruptedPlayback(new DOMException('Unsupported audio', 'NotSupportedError'))).toBe(
      false
    );
    expect(isInterruptedPlayback(new Error('Audio playback failed'))).toBe(false);
  });
});

describe('requestSpeechUnlessMuted', () => {
  test('makes absolutely no synthesis request while muted', async () => {
    let calls = 0;
    const result = await requestSpeechUnlessMuted(true, { text: 'done' }, async () => {
      calls += 1;
      return { audioUrl: '/audio.mp3' };
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  test('allows an explicit replay while muted', async () => {
    let calls = 0;
    const result = await requestSpeechUnlessMuted(
      true,
      { text: 'again', announcementId: 'a-1' },
      async () => {
        calls += 1;
        return { audioUrl: '/audio.mp3' };
      },
      true
    );
    expect(result?.audioUrl).toBe('/audio.mp3');
    expect(calls).toBe(1);
  });
});
