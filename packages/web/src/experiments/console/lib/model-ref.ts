export function piBackendLabel(id: string): string {
  const labels: Record<string, string> = {
    'azure-openai-responses': 'Azure OpenAI',
    openrouter: 'OpenRouter',
    openai: 'OpenAI',
    'openai-codex': 'OpenAI Codex',
    'github-copilot': 'GitHub Copilot',
    'vercel-ai-gateway': 'Vercel AI Gateway',
  };
  return labels[id] ?? id;
}

export function splitPiModelRef(value: string): { backend: string; model: string } {
  const index = value.indexOf('/');
  return index > 0
    ? { backend: value.slice(0, index), model: value.slice(index + 1) }
    : { backend: '', model: value };
}

export function joinPiModelRef(backend: string, model: string): string {
  const cleanBackend = backend.trim();
  if (cleanBackend === '') return model;
  return `${cleanBackend}/${model}`;
}
