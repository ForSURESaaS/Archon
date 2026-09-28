import { useEffect, useState, type ReactElement } from 'react';
import * as skill from '../skills';
import { SettingsSection } from './SettingsSection';

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] as const;

export function AudioSettingsPanel(): ReactElement {
  const [config, setConfig] = useState<skill.AudioConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void skill
      .getAudioConfig()
      .then(value => {
        if (active) setConfig(value);
      })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return (): void => {
      active = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    if (config === null) return;
    setSaving(true);
    setError(null);
    try {
      setConfig(await skill.updateAudioConfig(config));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Audio">
      {config === null ? (
        <p className="font-mono text-[11px] text-text-tertiary">{error ?? 'Loading…'}</p>
      ) : (
        <div className="grid gap-4">
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              <strong className="block text-text-primary">Spoken announcements</strong>
              <span className="text-xs text-text-tertiary">
                Generate audio for console announcements.
              </span>
            </span>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={event => {
                setConfig({ ...config, enabled: event.target.checked });
              }}
            />
          </label>
          <label className="grid gap-1 text-xs text-text-secondary">
            Voice
            <select
              className="rounded border border-border bg-surface-elevated px-3 py-2 text-text-primary"
              value={config.voice}
              onChange={event => {
                setConfig({ ...config, voice: event.target.value });
              }}
            >
              {VOICES.map(voice => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-xs text-text-secondary">
            Speech model
            <input
              className="rounded border border-border bg-surface-elevated px-3 py-2 text-text-primary"
              value={config.model}
              onChange={event => {
                setConfig({ ...config, model: event.target.value });
              }}
            />
          </label>
          {error !== null ? <p className="font-mono text-[11px] text-error">{error}</p> : null}
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="justify-self-end rounded border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-hover disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save audio settings'}
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
