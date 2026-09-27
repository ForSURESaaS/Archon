import { describe, expect, test } from 'bun:test';
import { jiraAccessDecision } from './jira';

describe('jiraAccessDecision', () => {
  test('allows unauthenticated solo mode only on an explicit loopback bind', () => {
    expect(
      jiraAccessDecision({ identityRequired: false, hostname: '127.0.0.1', user: null })
    ).toEqual({ userId: '' });
    expect(
      jiraAccessDecision({ identityRequired: false, hostname: 'localhost', user: null })
    ).toEqual({ userId: '' });
    expect(
      jiraAccessDecision({ identityRequired: false, hostname: '0.0.0.0', user: null })
    ).toEqual({ error: 'Authentication required', status: 401 });
  });

  test('rejects missing and non-admin identities on networked installs', () => {
    expect(jiraAccessDecision({ identityRequired: true, hostname: '0.0.0.0', user: null })).toEqual(
      { error: 'Authentication required', status: 401 }
    );
    expect(
      jiraAccessDecision({
        identityRequired: true,
        hostname: '0.0.0.0',
        user: { id: 'member-1', role: 'member' },
      })
    ).toEqual({ error: 'Administrator access required', status: 403 });
  });

  test('allows an authenticated administrator and preserves attribution', () => {
    expect(
      jiraAccessDecision({
        identityRequired: true,
        hostname: '0.0.0.0',
        user: { id: 'admin-1', role: 'admin' },
      })
    ).toEqual({ userId: 'admin-1' });
  });
});
