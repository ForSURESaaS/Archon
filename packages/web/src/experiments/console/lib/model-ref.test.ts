import { describe, expect, test } from 'bun:test';
import { joinPiModelRef, piBackendLabel, splitPiModelRef } from './model-ref';

describe('Pi model refs', () => {
  test('splits a backend from a nested model id', () => {
    expect(splitPiModelRef('openrouter/openai/gpt-5.6-sol')).toEqual({
      backend: 'openrouter',
      model: 'openai/gpt-5.6-sol',
    });
  });

  test('keeps a model without a backend as free text', () => {
    expect(splitPiModelRef('custom-model')).toEqual({
      backend: '',
      model: 'custom-model',
    });
  });

  test('joins backend and model without losing a pending backend selection', () => {
    expect(joinPiModelRef('azure-openai-responses', '')).toBe('azure-openai-responses/');
    expect(joinPiModelRef('azure-openai-responses', 'gpt-5.6-terra')).toBe(
      'azure-openai-responses/gpt-5.6-terra'
    );
  });

  test('uses readable labels for known API providers', () => {
    expect(piBackendLabel('azure-openai-responses')).toBe('Azure OpenAI');
    expect(piBackendLabel('custom-gateway')).toBe('custom-gateway');
  });
});
