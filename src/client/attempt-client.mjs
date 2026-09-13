/**
 * Attempt controller: the client-side state machine for one student, one test.
 *
 * Two rules shape this file:
 *
 * 1. The server owns time. The countdown shown to a student is the server's deadline
 *    corrected by a measured clock offset, never the device clock. A student whose phone
 *    is set forward by an hour still gets exactly their 25 minutes.
 * 2. The browser never learns anything about correctness. There is no key here, no
 *    scoring, no "your answer looks right" — only the answers the student typed.
 */

import { createActivityLog } from './activity-log.mjs';
import { createSubmissionQueue, isRetryable, backoffDelayMs } from './submission-queue.mjs';
import { computeAwayTime } from './away-time.mjs';

export const ATTEMPT_STATES = {
  UNSTARTED: 'unstarted',
  RUNNING: 'running',
  FROZEN: 'frozen',
  SUBMITTING: 'submitting',
  COMPLETE: 'complete',
  REFUSED: 'refused',
  // Time ran out before this page opened, and this page holds none of the attempt's answers.
  EXPIRED: 'expired'
};

/**
 * Spread the herd: a whole room hitting the endpoint in the same second is a self-DoS, and Apps
 * Script runs at most 30 requests at once. Answers are frozen at the deadline, so the wait costs
 * nothing; the server's 60-second grace keeps it from counting as late.
 */
export const AUTO_SUBMIT_JITTER_MS = 20_000;

/**
 * A start refused because the server is busy is tried again, spread out at random, instead of
 * telling the student it failed: Apps Script turns away requests beyond 30 at once, which a room
 * pressing Start together can exceed for a few seconds. At most about 35 seconds in all.
 */
export const START_RETRY = Object.freeze({ maxAttempts: 6, baseDelayMs: 1_500, maxDelayMs: 12_000 });

export function createAttemptClient({
  endpoint,
  storage,
  clock = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  newSubmissionId = () => `sub-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 14)}`
}) {
  const activity = createActivityLog({ clock });
  // The client is created as the page loads, so this approximates when the page opened.
  const pageOpenedAtMs = clock();
  let attemptStartClientMs = null;
  let endedAtClientMs = null;
  let state = ATTEMPT_STATES.UNSTARTED;
  let artifact = null;
  let deadlineMs = null;
  let clockOffsetMs = 0;
  let attemptId = null;
  let testId = null;
  let awayTimeApproximate = false;
  let refusal = null;
  let submissionId = null;
  const answers = {};
  let answersKey = null;
  let openedAfterDeadline = false;
  let pendingPayload = null;
  let autoSubmitStarted = false;

  // One queue per attempt, created at start, so on a shared device one student's unsent
  // answers are never overwritten by the next student's.
  const makeQueue = (key) => createSubmissionQueue({
    send: (payload) => endpoint.submitAttempt(payload),
    storage, clock, wait, random,
    storageKey: key
  });
  let queue = makeQueue('scioly.pending-submission');

  // Answers are kept on this device as they are chosen, so a reload or a crashed browser
  // resumes with them. Only answers and the attempt id: no name, email, or access code.
  function saveAnswers() {
    if (!answersKey) return;
    try { storage?.setItem(answersKey, JSON.stringify(answers)); } catch { /* the in-memory answers still stand */ }
  }
  function loadAnswers() {
    try {
      const saved = JSON.parse(storage?.getItem(answersKey) ?? 'null');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  }
  function clearSavedAnswers() {
    try { storage?.removeItem(answersKey); } catch { /* nothing useful to do */ }
  }

  /** Server time as best we can estimate it locally. */
  const serverNow = () => clock() + clockOffsetMs;

  /**
   * Sends only what the student typed. The server decides which test the code opens,
   * which roster row the name is, and when the attempt started.
   */
  async function start({ accessCode, firstName, lastName, grade, email }, { onRetry } = {}) {
    let response;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // Safe to repeat: a start that did reach the server is resumed, not duplicated.
        response = await endpoint.startAttempt({ accessCode, firstName, lastName, grade, email });
        break;
      } catch (error) {
        if (!isRetryable(error) || attempt >= START_RETRY.maxAttempts) throw error;
        onRetry?.(attempt);
        await wait(backoffDelayMs(attempt, START_RETRY, random));
      }
    }
    if (!response.ok) {
      state = ATTEMPT_STATES.REFUSED;
      refusal = response.reason;
      return { ok: false, reason: response.reason };
    }
    // Offset measured once, at delivery: from here the countdown is server-anchored.
    clockOffsetMs = response.serverNowMs - clock();
    artifact = response.artifact;
    deadlineMs = response.deadlineMs;
    attemptId = response.attemptId;
    testId = response.testId;
    submissionId = newSubmissionId();
    queue = makeQueue(`scioly.pending-submission.${attemptId}`);
    answersKey = `scioly.answers.${attemptId}`;
    Object.assign(answers, loadAnswers());
    openedAfterDeadline = isExpired();
    // Submitted on this device before a reload, but not confirmed: send that exact payload
    // again. Its submission id is unchanged, so if it did arrive the server treats it as a retry.
    const pending = queue.loadPersisted();
    if (pending && pending.attemptId === attemptId) {
      pendingPayload = pending;
      submissionId = pending.submissionId;
      Object.assign(answers, pending.answers ?? {});
      autoSubmitStarted = true;
    }
    // Away time is informational and must never stop a student starting. If the server
    // ever omits firstDeliveryMs, measure from now and mark the figure approximate.
    const firstDeliveryMs = Number.isFinite(response.firstDeliveryMs) ? response.firstDeliveryMs : response.serverNowMs;
    awayTimeApproximate = !Number.isFinite(response.firstDeliveryMs);
    attemptStartClientMs = firstDeliveryMs - clockOffsetMs;
    // Keyed by attempt: a resume returns the same attemptId, so the earlier page's log is found.
    activity.persistTo(storage, `scioly.activity.${attemptId}`, {
      resumed: response.decision === 'resumed',
      reopenedAtMs: pageOpenedAtMs
    });
    state = ATTEMPT_STATES.RUNNING;
    return {
      ok: true, decision: response.decision, artifact, deadlineMs, remainingMs: remainingMs(),
      restoredAnswers: Object.keys(answers).length
    };
  }

  /** Sends the unconfirmed submission found at start. Returns null when there was none. */
  async function resendPending() {
    if (!pendingPayload) return null;
    freeze();
    state = ATTEMPT_STATES.SUBMITTING;
    const result = await queue.submit(pendingPayload);
    if (result.state === 'accepted') {
      state = ATTEMPT_STATES.COMPLETE;
      pendingPayload = null;
      clearSavedAnswers();
    }
    return result;
  }

  function remainingMs() {
    if (deadlineMs === null) return null;
    return Math.max(0, deadlineMs - serverNow());
  }

  function isExpired() {
    return deadlineMs !== null && serverNow() >= deadlineMs;
  }

  /** Record an answer. Refused once frozen — that is what "freeze" means. */
  function setAnswer(questionId, value) {
    if (state !== ATTEMPT_STATES.RUNNING) return { accepted: false, state };
    if (isExpired()) {
      freeze();
      return { accepted: false, state };
    }
    answers[questionId] = value;
    saveAnswers();
    return { accepted: true, state };
  }

  function freeze() {
    if (state === ATTEMPT_STATES.RUNNING) {
      state = ATTEMPT_STATES.FROZEN;
      endedAtClientMs = Math.min(clock(), deadlineMs - clockOffsetMs);
    }
    return state;
  }

  /** Away time within this attempt, in device-clock terms (durations are unaffected by skew). */
  function awayTime() {
    if (attemptStartClientMs === null) return computeAwayTime([], { startMs: 0, endMs: 0 });
    const endMs = endedAtClientMs ?? Math.min(clock(), deadlineMs - clockOffsetMs);
    return { ...computeAwayTime(activity.events, { startMs: attemptStartClientMs, endMs }), approximate: awayTimeApproximate };
  }

  function buildPayload({ auto }) {
    // Exactly the submit contract. Away time is not sent: the server recomputes it from
    // the raw events rather than trusting the phone's own total.
    return {
      attemptId,
      submissionId,
      answers: { ...answers },
      activity: activity.events,
      clientSubmittedAtMs: clock(),
      clientServerNowMs: serverNow(),
      auto
    };
  }

  async function submit({ auto = false, jitter = false } = {}) {
    if (state === ATTEMPT_STATES.COMPLETE) return { state, receipt: queue.receipt };
    freeze();
    if (jitter) await wait(Math.round(random() * AUTO_SUBMIT_JITTER_MS));
    state = ATTEMPT_STATES.SUBMITTING;
    const result = await queue.submit(buildPayload({ auto }));
    state = result.state === 'accepted' ? ATTEMPT_STATES.COMPLETE : ATTEMPT_STATES.SUBMITTING;
    if (state === ATTEMPT_STATES.COMPLETE) clearSavedAnswers();
    return result;
  }

  /**
   * Called by the countdown tick. Freezes and auto-submits exactly once at expiry.
   * Idempotent, because a tick can fire more than once around the boundary.
   */
  async function tick() {
    if (!isExpired() || autoSubmitStarted) return { state, remainingMs: remainingMs() };
    autoSubmitStarted = true;
    freeze();
    // Reopened after time ran out, on a page with none of this attempt's answers. Sending an
    // empty set would be accepted first and turn the real answers, still on the device the
    // student used, into a duplicate.
    if (openedAfterDeadline && Object.keys(answers).length === 0) {
      state = ATTEMPT_STATES.EXPIRED;
      return { state };
    }
    return submit({ auto: true, jitter: true });
  }

  return {
    start, tick, submit, resendPending, setAnswer, freeze, remainingMs, isExpired, awayTime,
    activity,
    get queue() { return queue; },
    get hasPendingSubmission() { return pendingPayload !== null; },
    get state() { return state; },
    get artifact() { return artifact; },
    get answers() { return { ...answers }; },
    get deadlineMs() { return deadlineMs; },
    get attemptId() { return attemptId; },
    get testId() { return testId; },
    get refusal() { return refusal; },
    get clockOffsetMs() { return clockOffsetMs; }
  };
}
