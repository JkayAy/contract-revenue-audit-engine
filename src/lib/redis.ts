import Redis, { type RedisOptions } from 'ioredis';

declare global {
    // eslint-disable-next-line no-var
  var __auditRedisClient: Redis | undefined;
    // eslint-disable-next-line no-var
  var __auditRedisWorkerClient: Redis | undefined;
}

function buildRedisOptions(): RedisOptions {
    const url = process.env.REDIS_URL;

  if (!url) {
        throw new Error(
                'REDIS_URL is not defined. Set it before starting the app or worker.'
              );
  }

  return {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: false,
        retryStrategy(attempts: number) {
                return Math.min(attempts * 200, 5000);
        },
        reconnectOnError(err: Error) {
                const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET'];
                return targetErrors.some((code) => err.message.includes(code));
        },
  };
}

function createRedisClient(): Redis {
    const url = process.env.REDIS_URL as string;
    const client = new Redis(url, buildRedisOptions());

  client.on('error', (err) => {
        // eslint-disable-next-line no-console
                console.error('[redis] client error', err);
  });

  client.on('connect', () => {
        // eslint-disable-next-line no-console
                console.info('[redis] connected');
  });

  return client;
}

/**
 * Shared Redis client for use in the Next.js server runtime
 * (route handlers, server actions, idempotency locks).
 *
 * A single connection is memoized on the global object to avoid
 * exhausting connections during Next.js hot-reload in development.
 */
export function getRedisClient(): Redis {
    if (!global.__auditRedisClient) {
          global.__auditRedisClient = createRedisClient();
    }
    return global.__auditRedisClient;
}

/**
 * Dedicated Redis client for the standalone BullMQ worker process.
 * Kept separate from the web client so the worker process, which runs
 * in its own Node.js process, never shares a memoized handle with the
 * web server thread.
 */
export function getWorkerRedisClient(): Redis {
    if (!global.__auditRedisWorkerClient) {
          global.__auditRedisWorkerClient = createRedisClient();
    }
    return global.__auditRedisWorkerClient;
}

/**
 * Acquire a short-lived distributed lock in Redis, used to guarantee
 * idempotent processing of inbound webhook events.
 *
 * Returns true if the lock was acquired, false if another process
 * already holds it, meaning this event has already been received.
 */
export async function acquireIdempotencyLock(
    key: string,
    ttlSeconds = 60 * 10
  ): Promise<boolean> {
    const client = getRedisClient();
    const result = await client.set(`idempotency:${key}`, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
}

export async function releaseIdempotencyLock(key: string): Promise<void> {
    const client = getRedisClient();
    await client.del(`idempotency:${key}`);
}
