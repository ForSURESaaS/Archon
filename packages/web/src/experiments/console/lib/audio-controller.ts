import type { AudioAnnouncement, SpeechRequest, SpeechResponse } from '../skills/audio';

export const AUDIO_MUTED_KEY = 'archon.console.audio.muted';
export const AUDIO_VOLUME_KEY = 'archon.console.audio.volume';

export interface AudioPreferences {
  muted: boolean;
  volume: number;
}

export interface AudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readAudioPreferences(storage: AudioStorage | undefined): AudioPreferences {
  if (storage === undefined) return { muted: false, volume: 1 };
  try {
    const storedVolume = storage.getItem(AUDIO_VOLUME_KEY);
    const volume = storedVolume === null ? 1 : Number(storedVolume);
    return {
      muted: storage.getItem(AUDIO_MUTED_KEY) === 'true',
      volume: Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 1,
    };
  } catch {
    return { muted: false, volume: 1 };
  }
}

export function writeAudioPreferences(
  storage: AudioStorage | undefined,
  preferences: AudioPreferences
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(AUDIO_MUTED_KEY, String(preferences.muted));
    storage.setItem(AUDIO_VOLUME_KEY, String(preferences.volume));
  } catch {
    // Audio controls still work for the session when storage is unavailable.
  }
}

export async function requestSpeechUnlessMuted(
  muted: boolean,
  request: SpeechRequest,
  synthesize: (value: SpeechRequest) => Promise<SpeechResponse>,
  explicitReplay = false
): Promise<SpeechResponse | null> {
  if (muted && !explicitReplay) return null;
  return synthesize(request);
}

export function isInterruptedPlayback(cause: unknown): boolean {
  // A new load or user pause aborts only the pending play() request; it does
  // not mean synthesis or the generated audio failed. Actual media errors
  // still arrive through the audio element's onError handler.
  return cause instanceof DOMException && cause.name === 'AbortError';
}

export function announcementSpeechRequest(announcement: AudioAnnouncement): SpeechRequest {
  return {
    text: announcement.text,
    announcementId: announcement.id,
  };
}
