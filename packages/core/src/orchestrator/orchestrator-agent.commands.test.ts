import { describe, expect, test } from 'bun:test';
import { normalizeCommandText } from './orchestrator-agent';

describe('normalizeCommandText', () => {
  test('moves an indented bare orchestrator command to column zero', () => {
    expect(normalizeCommandText('  /invoke-workflow deliver')).toBe('/invoke-workflow deliver');
    expect(normalizeCommandText('\t/register-project app /tmp/app')).toBe(
      '/register-project app /tmp/app'
    );
  });

  test('continues to unwrap markdown-emphasized command lines', () => {
    expect(normalizeCommandText(' **/invoke-workflow deliver** ')).toBe('/invoke-workflow deliver');
  });

  test('does not alter slash text embedded in prose', () => {
    expect(normalizeCommandText('Please run /invoke-workflow deliver')).toBe(
      'Please run /invoke-workflow deliver'
    );
  });
});
