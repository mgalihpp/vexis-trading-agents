export interface RetryPolicyProfile {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitterMs: number;
}

export interface RetryContext {
  attempt: number;
  nextDelayMs: number;
  error: unknown;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const computeBackoffDelay = (profile: RetryPolicyProfile, attempt: number): number => {
  const base = profile.initialDelayMs * Math.pow(profile.backoffFactor, Math.max(0, attempt - 1));
  const jitter = profile.jitterMs > 0 ? Math.floor(Math.random() * profile.jitterMs) : 0;
  return Math.min(profile.maxDelayMs, base + jitter);
};

export const withRetry = async <T>(
  fn: (attempt: number) => Promise<T>,
  profile: RetryPolicyProfile,
  shouldRetry: (error: unknown) => boolean,
  onRetry?: (ctx: RetryContext) => Promise<void> | void
): Promise<T> => {
  const maxAttempts = Math.max(1, profile.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        break;
      }
      const nextDelayMs = computeBackoffDelay(profile, attempt);
      if (onRetry) {
        await onRetry({ attempt, nextDelayMs, error });
      }
      await sleep(nextDelayMs);
    }
  }

  throw lastError;
};

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export class RateLimitGovernor {
  private readonly nextAllowedAt = new Map<string, number>();

  public constructor(private readonly requestsPerSecond: number, private readonly nowMs: () => number = () => Date.now()) {}

  public async waitTurn(key: string): Promise<void> {
    const now = this.nowMs();
    const minInterval = this.requestsPerSecond <= 0 ? 0 : Math.ceil(1000 / this.requestsPerSecond);
    const readyAt = this.nextAllowedAt.get(key) ?? now;
    const waitMs = Math.max(0, readyAt - now);
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    const nextAt = Math.max(readyAt, now) + minInterval;
    this.nextAllowedAt.set(key, nextAt);
  }
}

export class TimeoutBudget {
  private readonly startedAtMs: number;

  public constructor(private readonly totalMs: number, private readonly nowMs: () => number = () => Date.now()) {
    this.startedAtMs = this.nowMs();
  }

  public remainingMs(): number {
    if (this.totalMs <= 0) return Number.MAX_SAFE_INTEGER;
    const elapsed = this.nowMs() - this.startedAtMs;
    return Math.max(0, this.totalMs - elapsed);
  }

  public assertRemaining(step: string): void {
    if (this.remainingMs() <= 0) {
      throw new Error(`TIMEOUT_BUDGET_EXHAUSTED: ${step}`);
    }
  }
}
