import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import * as skill from '../skills';
import {
  announcementSpeechRequest,
  readAudioPreferences,
  requestSpeechUnlessMuted,
  writeAudioPreferences,
  type AudioPreferences,
} from '../lib/audio-controller';

interface AudioController extends AudioPreferences {
  setMuted: (muted: boolean) => void;
  setVolume: (volume: number) => void;
  replay: (announcement: skill.AudioAnnouncement) => Promise<void>;
}

const audioContext = createContext<AudioController | null>(null);

async function playUrl(url: string, volume: number): Promise<void> {
  const audio = new Audio(url);
  audio.volume = volume;
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = (): void => {
        resolve();
      };
      audio.onerror = (): void => {
        reject(new Error('Audio playback failed'));
      };
      void audio.play().catch(reject);
    });
  } finally {
    audio.onended = null;
    audio.onerror = null;
    URL.revokeObjectURL(url);
  }
}

export function AudioProvider({ children }: { children: ReactNode }): ReactElement {
  const [preferences, setPreferences] = useState(() =>
    readAudioPreferences(typeof window === 'undefined' ? undefined : window.localStorage)
  );
  const preferencesRef = useRef(preferences);
  const attemptedAnnouncementsRef = useRef(new Set<string>());
  preferencesRef.current = preferences;

  const patchPreferences = useCallback((patch: Partial<AudioPreferences>): void => {
    setPreferences(current => {
      const next = { ...current, ...patch };
      writeAudioPreferences(window.localStorage, next);
      return next;
    });
  }, []);

  const speak = useCallback(
    async (announcement: skill.AudioAnnouncement, explicitReplay = false): Promise<void> => {
      const response = await requestSpeechUnlessMuted(
        preferencesRef.current.muted,
        announcementSpeechRequest(announcement),
        skill.synthesizeSpeech,
        explicitReplay
      );
      if (response !== null) await playUrl(response.audioUrl, preferencesRef.current.volume);
    },
    []
  );

  useEffect(() => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      // The mute check is before announcement fetching as well as synthesis, so
      // background polling can never race into a synthesis request while muted.
      if (preferencesRef.current.muted) return;
      try {
        const result = await skill.getAudioAnnouncements();
        const pending = result.announcements
          .filter(
            announcement =>
              announcement.acknowledgedAt == null &&
              !attemptedAnnouncementsRef.current.has(announcement.id)
          )
          .reverse();
        for (const announcement of pending) {
          if (stopped || preferencesRef.current.muted) return;
          // Mark before synthesis: a failed request must not bill again every poll.
          attemptedAnnouncementsRef.current.add(announcement.id);
          try {
            await speak(announcement);
            await skill.acknowledgeAudioAnnouncement(announcement.id);
          } catch (error) {
            console.error('Audio announcement failed; use Replay to retry.', error);
          }
        }
      } catch {
        // Polling is best-effort; settings and Jira logs expose server failures.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 10_000);
    return (): void => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [speak]);

  const value = useMemo<AudioController>(
    () => ({
      ...preferences,
      setMuted: (muted: boolean): void => {
        patchPreferences({ muted });
      },
      setVolume: (volume: number): void => {
        patchPreferences({ volume: Math.max(0, Math.min(1, volume)) });
      },
      replay: (announcement: skill.AudioAnnouncement): Promise<void> => speak(announcement, true),
    }),
    [patchPreferences, preferences, speak]
  );

  return <audioContext.Provider value={value}>{children}</audioContext.Provider>;
}

export function useAudio(): AudioController {
  const controller = useContext(audioContext);
  if (controller === null) throw new Error('useAudio must be used within AudioProvider');
  return controller;
}
