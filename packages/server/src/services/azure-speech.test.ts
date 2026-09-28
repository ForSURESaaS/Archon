import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
  isAzureSpeechConfigured,
  SpeechConfigurationError,
  synthesizeAzureSpeech,
} from './azure-speech';

const ENV_KEYS = [
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'DEPLOYMENT_NAME_MAP',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function configure(): void {
  process.env.AZURE_OPENAI_BASE_URL = 'https://example.openai.azure.com/';
  process.env.AZURE_OPENAI_API_KEY = 'secret';
  process.env.AZURE_OPENAI_API_VERSION = '2025-01-01-preview';
  process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = 'gpt-audio-mini=audio-deployment';
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Azure speech synthesis', () => {
  test('reports readiness only when the deployment and credentials are configured', () => {
    configure();
    expect(isAzureSpeechConfigured()).toBe(true);
    delete process.env.AZURE_OPENAI_API_KEY;
    expect(isAzureSpeechConfigured()).toBe(false);
  });

  test('sends an ephemeral MP3 synthesis request to the mapped deployment', async () => {
    configure();
    const encoded = Buffer.from(new Uint8Array([1, 2, 3])).toString('base64');
    const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ choices: [{ message: { audio: { data: encoded } } }] })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await synthesizeAzureSpeech('hello', 'coral', 'gpt-audio-mini-global');

    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://example.openai.azure.com/openai/deployments/audio-deployment/chat/completions?api-version=2025-01-01-preview'
    );
    expect(init?.headers).toEqual({
      'api-key': 'secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'audio-deployment',
      modalities: ['text', 'audio'],
      audio: { voice: 'coral', format: 'mp3' },
      messages: [{ role: 'user', content: 'hello' }],
    });
  });

  test('uses the Azure v1 chat endpoint when API version is v1', async () => {
    configure();
    process.env.AZURE_OPENAI_API_VERSION = 'v1';
    const fetchMock = mock(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        choices: [{ message: { audio: { data: Buffer.from([1]).toString('base64') } } }],
      })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await synthesizeAzureSpeech('ready', 'coral');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://example.openai.azure.com/openai/v1/chat/completions'
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe('audio-deployment');
  });

  test('rejects malformed deployment configuration without exposing secrets', async () => {
    configure();
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = '{not-json';

    await expect(
      synthesizeAzureSpeech('hello', 'coral', 'gpt-audio-mini-global')
    ).rejects.toBeInstanceOf(SpeechConfigurationError);
  });
});
