/** The worker's own heartbeat row (`worker_heartbeats.worker_name`): written every 15 seconds by the worker, read by the API. */
export const WORKER_HEARTBEAT = 'worker';

/** Three missed heartbeats: the worker is not working (the dead-man alert, the feed state of the market snapshot). */
export const WORKER_ALIVE_MAX_AGE_MS = 45_000;

/** The worker that has gone quiet for longer than this is not working (`GET /health/ready`, 04 section 2). */
export const WORKER_READY_MAX_AGE_MS = 60_000;
