import { useEffect, useRef } from 'react';

/**
 * Refresh visible live views on a cadence and immediately after the user
 * returns to the tab. The callback ref avoids restarting the timer on renders.
 */
export function useBackgroundRefresh(
  refresh: () => void,
  intervalMs: number,
  enabled = true
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') refreshRef.current();
    };
    const timer = window.setInterval(refreshWhenVisible, intervalMs);

    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);

    return (): void => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [enabled, intervalMs]);
}
