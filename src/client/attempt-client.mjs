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
import { createSubmissionQueue } from './submission-queue.mjs';
import { computeAwayTime } from './away-time.mjs';

export const ATTEMPT_STATES = {
  UNSTARTED: 'unstarted',
  RUNNING: 'running',
  FROZEN: 'frozen',
  SUBMITTING: 'submitting',
  COMPLETE: 'complete',
  REFUSED: 'refused'
};

/** Spread the herd: 30 devices hitting the endpoint on the same second is a self-DoS. */
export const AUTO_SUBMIT_JITTER_MS = 10_000;

export function createAttemptClient({
  endpoint,
  storage,
  clock = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
  newSubmissionId = () => `sub-${Math.random().toString(36).slice(2, 10)}`
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

  const queue = createSubmissionQueue({
    send: (payload) => endpoint.submitAttempt(payload),
    storage, clock, wait, random,
    storageKey: 'scioly.pending-submission'
  });

  /** Server time as best we can estimate it locally. */
  const serverNow = () => clock() + clockOffsetMs;

  /**
   * Sends only what the student typed. The server decides which test the code opens,
   * which roster row the name is, and when the attempt started.
   */
  async function start({ accessCode, firstName, lastName, grade, email }) {
    const response = await endpoint.startAttempt({ accessCode, firstName, lastName, grade, email });
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
    return { ok: true, decision: response.decision, artifact, deadlineMs, remainingMs: remainingMs() };
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
    return result;
  }

  /**
   * Called by the countdown tick. Freezes and auto-submits exactly once at expiry.
   * Idempotent, because a tick can fire more than once around the boundary.
   */
  let autoSubmitStarted = false;
  async function tick() {
    if (!isExpired() || autoSubmitStarted) return { state, remainingMs: remainingMs() };
    autoSubmitStarted = true;
    freeze();
    return submit({ auto: true, jitter: true });
  }

  return {
    start, tick, submit, setAnswer, freeze, remainingMs, isExpired, awayTime,
    activity, queue,
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
