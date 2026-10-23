/** Only a path inside this app is accepted as the place to go after login (no open redirect). */
export function safeRedirectTarget(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const from = (state as { from?: unknown }).from;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) {
      if (!from.startsWith('/\\') && !from.startsWith('/login')) return from;
    }
  }
  return '/';
}
