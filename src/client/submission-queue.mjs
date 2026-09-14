/**
 * Durable submission with bounded retry.
 *
 * A tryout runs on 30 phones on school Wi-Fi. Transport failures are expected, so the
 * frozen payload is persisted BEFORE the first send attempt and is only cleared once an
 * accepted receipt comes back. A student's answers must survive a dropped connection, a
 * reload, and a flat battery.
 *
 * Retryable and terminal failures are handled differently on purpose (decision-log
 * R3-13): retrying forever against a definite rejection hides the problem from the
 * proctor, who is the only one who can actually fix it.
 */

export const QUEUE_STATES = {
  IDLE: 'idle',
  PENDING: 'pending',
  RETRYING: 'retrying',
  ACCEPTED: 'accepted',
  FAILED_TERMINAL: 'failed-terminal',
  EXHAUSTED: 'exhausted'
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A failure with no HTTP status is a transport failure: retry it. */
export function isRetryable(error) {
  if (error?.retryable === true) return true;
  if (error?.retryable === false) return false;
  if (typeof error?.status !== 'number') return true;
  return RETRYABLE_STATUSES.has(error.status);
}

const DEFAULTS = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000
};

/**
 * Exponential backoff with full jitter, so 30 devices that all lost the same access
 * point do not retry in lockstep and knock the endpoint over again.
 */
export function backoffDelayMs(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

export function createSubmissionQueue({
  send,
  storage,
  storageKey = 'scioly.pending-submission',
  clock = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  options = {}
} = {}) {
  const settings = { ...DEFAULTS, ...options };
  let state = QUEUE_STATES.IDLE;
  let attemptCount = 0;
  let lastError = null;
  let receipt = null;

  const history = [];
  const note = (event) => history.push({ ...event, atMs: clock() });

  function persist(payload) {
    try {
      storage?.setItem(storageKey, JSON.stringify(payload));
    } catch (error) {
      // Private-mode storage can throw. The in-memory payload still gets its retries;
      // losing durability is worse than losing nothing, so we record and continue.
      note({ type: 'persist-failed', message: String(error?.message ?? error) });
    }
  }

  function clearPersisted() {
    try {
      storage?.removeItem(storageKey);
    } catch { /* nothing useful to do; the payload is already accepted */ }
  }

  /** A payload persisted by an earlier page load, for recovery after a reload. */
  function loadPersisted() {
    try {
      const raw = storage?.getItem(storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function submit(payload) {
    persist(payload);
    state = QUEUE_STATES.PENDING;
    attemptCount = 0;
    lastError = null;

    while (attemptCount < settings.maxAttempts) {
      attemptCount += 1;
      try {
        const response = await send(payload);
        receipt = response;
        state = QUEUE_STATES.ACCEPTED;
        clearPersisted();
        note({ type: 'accepted', attempt: attemptCount, outcome: response?.outcome });
        return { state, receipt, attempts: attemptCount };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) {
          state = QUEUE_STATES.FAILED_TERMINAL;
          note({ type: 'terminal', attempt: attemptCount, message: String(error?.message ?? error) });
          // Payload deliberately left persisted: the proctor may still need it.
          return { state, error, attempts: attemptCount };
        }
        note({ type: 'retry', attempt: attemptCount, message: String(error?.message ?? error) });
        if (attemptCount < settings.maxAttempts) {
          state = QUEUE_STATES.RETRYING;
          await wait(backoffDelayMs(attemptCount, settings, random));
        }
      }
    }

    state = QUEUE_STATES.EXHAUSTED;
    note({ type: 'exhausted', attempt: attemptCount });
    return { state, error: lastError, attempts: attemptCount };
  }

  return {
    submit,
    loadPersisted,
    get state() { return state; },
    get attempts() { return attemptCount; },
    get receipt() { return receipt; },
    get lastError() { return lastError; },
    get history() { return [...history]; },
    /** Proctor-facing description; never shows a score or correctness. */
    statusText() {
      switch (state) {
        case QUEUE_STATES.ACCEPTED: return 'Submitted — receipt received.';
        case QUEUE_STATES.PENDING: return 'Submitting…';
        case QUEUE_STATES.RETRYING: return `Connection problem — retrying (attempt ${attemptCount}).`;
        case QUEUE_STATES.FAILED_TERMINAL: return `Rejected: ${lastError?.message ?? 'unknown reason'}. Show this screen to your proctor.`;
        case QUEUE_STATES.EXHAUSTED: return 'Could not submit after repeated attempts. Show this screen to your proctor.';
        default: return 'Not submitted.';
      }
    }
  };
}
