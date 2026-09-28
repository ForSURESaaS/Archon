const AUDIO_MODEL = 'gpt-audio-mini';
export const DEFAULT_AUDIO_DEPLOYMENT = 'gpt-audio-mini-global';

export class SpeechConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechConfigurationError';
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new SpeechConfigurationError(`${name} is not configured`);
  return value;
}

function resolveDeployment(configuredDeployment = DEFAULT_AUDIO_DEPLOYMENT): string {
  const raw =
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP?.trim() ?? process.env.DEPLOYMENT_NAME_MAP?.trim();
  if (!raw) return configuredDeployment;

  const entries = new Map<string, string>();
  if (raw.startsWith('{')) {
    let mapping: unknown;
    try {
      mapping = JSON.parse(raw);
    } catch {
      throw new SpeechConfigurationError(
        'AZURE_OPENAI_DEPLOYMENT_NAME_MAP must be valid JSON or comma-separated model=deployment pairs'
      );
    }
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new SpeechConfigurationError('AZURE_OPENAI_DEPLOYMENT_NAME_MAP must be a JSON object');
    }
    for (const [model, deployment] of Object.entries(mapping)) {
      if (typeof deployment === 'string' && deployment.trim()) {
        entries.set(model.trim(), deployment.trim());
      }
    }
  } else {
    for (const pair of raw.split(',')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const model = pair.slice(0, separator).trim();
      const deployment = pair.slice(separator + 1).trim();
      if (model && deployment) entries.set(model, deployment);
    }
  }
  return (
    entries.get(AUDIO_MODEL) ??
    entries.get(configuredDeployment) ??
    entries.get(DEFAULT_AUDIO_DEPLOYMENT) ??
    configuredDeployment
  );
}

export function isAzureSpeechConfigured(): boolean {
  try {
    requiredEnv('AZURE_OPENAI_BASE_URL');
    requiredEnv('AZURE_OPENAI_API_KEY');
    requiredEnv('AZURE_OPENAI_API_VERSION');
    return true;
  } catch {
    return false;
  }
}

export async function synthesizeAzureSpeech(
  input: string,
  voice: string,
  configuredDeployment = DEFAULT_AUDIO_DEPLOYMENT,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const baseUrl = requiredEnv('AZURE_OPENAI_BASE_URL').replace(/\/+$/, '');
  const apiKey = requiredEnv('AZURE_OPENAI_API_KEY');
  const apiVersion = requiredEnv('AZURE_OPENAI_API_VERSION');
  const deployment = resolveDeployment(configuredDeployment);
  // Azure v1 uses the model in the request body; dated APIs use the deployment in the path.
  const url =
    apiVersion === 'v1'
      ? `${baseUrl}/openai/v1/chat/completions`
      : `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions` +
        `?api-version=${encodeURIComponent(apiVersion)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: deployment,
      modalities: ['text', 'audio'],
      audio: { voice, format: 'mp3' },
      messages: [{ role: 'user', content: input }],
    }),
    signal,
  });
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    throw new Error(
      `Azure speech synthesis failed (${response.status})${requestId ? ` [${requestId}]` : ''}`
    );
  }
  const payload = (await response.json()) as {
    choices?: { message?: { audio?: { data?: string } } }[];
  };
  const encoded = payload.choices?.[0]?.message?.audio?.data;
  if (!encoded) throw new Error('Azure speech response did not include audio data');
  return Uint8Array.from(Buffer.from(encoded, 'base64')).buffer;
}
