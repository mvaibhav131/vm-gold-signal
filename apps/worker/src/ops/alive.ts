/** The recorder writes its heartbeat under this name every 15 seconds (`worker_heartbeats.worker_name`). */
export const WORKER_HEARTBEAT = 'worker';

/** Three missed heartbeats: the worker is not working. */
export const WORKER_ALIVE_MAX_AGE_MS = 45_000;

export interface HeartbeatReader {
  query(text: string, values: unknown[]): Promise<{ rows: readonly { heartbeat_at: Date }[] }>;
}

/** The age of the worker's own heartbeat, or null when there is none. */
export async function workerHeartbeatAgeMs(
  db: HeartbeatReader,
  now: number,
): Promise<number | null> {
  const { rows } = await db.query(
    'SELECT heartbeat_at FROM worker_heartbeats WHERE worker_name = $1',
    [WORKER_HEARTBEAT],
  );
  const at = rows[0]?.heartbeat_at;
  return at === undefined ? null : now - at.getTime();
}

export function isFresh(ageMs: number | null, maxAgeMs: number = WORKER_ALIVE_MAX_AGE_MS): boolean {
  return ageMs !== null && ageMs <= maxAgeMs;
}
