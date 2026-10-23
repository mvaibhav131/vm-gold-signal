import { useEffect, useState } from 'react';

/** Sets the browser tab title; screen readers announce a changed title on navigation. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · VM Gold Signal`;
  }, [title]);
}

/** The current time in milliseconds, refreshed every `intervalMs` (countdowns). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);
  return now;
}
