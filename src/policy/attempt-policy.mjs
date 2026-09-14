/**
 * Pure attempt-authorization policy.
 *
 * No I/O, no clock of its own, no roster. Every decision is a function of the session
 * window, the configuration, the attempts already on record, and an explicit `nowMs`.
 * That is deliberate: these rules decide who gets to take a test and for how long, so
 * they must be testable without a server, and reproducible from a record after the fact.
 *
 * The server is the only authority for time. Nothing here trusts a client-supplied
 * clock, and the deadline is derived from the server-recorded first delivery.
 */

import { SESSION_PHASES, sessionPhase } from './session-window.mjs';

export const START_DECISIONS = {
  AUTHORIZED: 'authorized',
  RESUMED: 'resumed',
  REFUSED: 'refused'
};

export const REFUSAL = {
  BAD_ACCESS_CODE: 'bad-access-code',
  SESSION_NOT_OPEN: 'session-not-open',
  SESSION_CLOSED: 'session-closed',
  LATE_START_CLOSED: 'late-start-closed',
  BLOCK_ALREADY_USED: 'block-already-used',
  SESSION_CAP_REACHED: 'session-cap-reached'
};

/**
 * The deadline for an attempt.
 *
 * `firstDeliveryMs` is immutable once recorded — a refresh, a second device, or a
 * re-fetch never moves it (decision-log R3-4). Extensions add to it; the hard close
 * caps it unconditionally.
 */
export function computeDeadlineMs({ firstDeliveryMs, attemptMinutes, extensionMinutesTotal = 0, hardCloseMs }) {
  const earned = firstDeliveryMs + (attemptMinutes + extensionMinutesTotal) * 60_000;
  return Math.min(earned, hardCloseMs);
}

export function grantedExtensionMinutes(attempt) {
  return (attempt.extensions ?? []).reduce((sum, extension) => sum + extension.minutes, 0);
}

function attemptsForIdentity(priorAttempts, identityKey) {
  return priorAttempts.filter((attempt) => attempt.identityKey === identityKey);
}

/**
 * Decide whether a student may begin (or resume) an attempt.
 *
 * Resuming an existing attempt is always permitted, including after the last normal
 * start and after the hard close. Refusing a resume would strand a student who merely
 * refreshed the page, and it cannot grant extra time: the deadline is already fixed.
 */
export function authorizeStart({ window, config, request, priorAttempts = [], nowMs }) {
  const { identityKey, testId, blockId, accessCodeValid } = request;

  const existing = priorAttempts.find((a) => a.identityKey === identityKey && a.testId === testId);
  if (existing) {
    return {
      decision: START_DECISIONS.RESUMED,
      attempt: existing,
      firstDeliveryMs: existing.firstDeliveryMs,
      deadlineMs: computeDeadlineMs({
        firstDeliveryMs: existing.firstDeliveryMs,
        attemptMinutes: config.attemptMinutes,
        extensionMinutesTotal: grantedExtensionMinutes(existing),
        hardCloseMs: window.hardCloseMs
      }),
      serverNowMs: nowMs
    };
  }

  const refuse = (reason) => ({ decision: START_DECISIONS.REFUSED, reason, serverNowMs: nowMs });

  // The access code gates a test, not a person. It is checked first so that an invalid
  // code never reveals whether a name, block, or cap would also have refused.
  if (!accessCodeValid) return refuse(REFUSAL.BAD_ACCESS_CODE);

  const phase = sessionPhase(window, nowMs);
  if (phase === SESSION_PHASES.BEFORE_OPEN) return refuse(REFUSAL.SESSION_NOT_OPEN);
  if (phase === SESSION_PHASES.CLOSED) return refuse(REFUSAL.SESSION_CLOSED);
  if (phase === SESSION_PHASES.LATE_START_CLOSED) return refuse(REFUSAL.LATE_START_CLOSED);

  const mine = attemptsForIdentity(priorAttempts, identityKey);
  if (mine.some((attempt) => attempt.blockId === blockId)) return refuse(REFUSAL.BLOCK_ALREADY_USED);
  if (mine.length >= config.maxTestsPerSession) return refuse(REFUSAL.SESSION_CAP_REACHED);

  return {
    decision: START_DECISIONS.AUTHORIZED,
    firstDeliveryMs: nowMs,
    deadlineMs: computeDeadlineMs({
      firstDeliveryMs: nowMs,
      attemptMinutes: config.attemptMinutes,
      hardCloseMs: window.hardCloseMs
    }),
    serverNowMs: nowMs,
    attempt: { identityKey, testId, blockId, firstDeliveryMs: nowMs, extensions: [] }
  };
}

export const SUBMISSION_OUTCOMES = {
  ACCEPTED: 'accepted',
  DUPLICATE: 'duplicate',
  REPLAY: 'replay',
  REJECTED_NO_DELIVERY: 'rejected-no-delivery'
};

/**
 * Decide what happens to an arriving submission.
 *
 * Window checks govern content delivery only. A submission for a valid attempt is
 * always retained and, if structurally sound, accepted — marked late rather than
 * discarded (decision-log R3-13). Losing a student's answers because their phone
 * reconnected after the close is not a recoverable error.
 */
export function authorizeSubmission({ window, config, attempt, submission, priorSubmissions = [], nowMs }) {
  const base = { receiptMs: nowMs, testId: submission.testId, submissionId: submission.submissionId };

  if (!attempt || attempt.firstDeliveryMs === undefined) {
    return { ...base, outcome: SUBMISSION_OUTCOMES.REJECTED_NO_DELIVERY, retained: true, late: false };
  }

  const replay = priorSubmissions.find((s) => s.submissionId === submission.submissionId);
  if (replay) return { ...replay, outcome: SUBMISSION_OUTCOMES.REPLAY, retained: true };

  const deadlineMs = computeDeadlineMs({
    firstDeliveryMs: attempt.firstDeliveryMs,
    attemptMinutes: config.attemptMinutes,
    extensionMinutesTotal: grantedExtensionMinutes(attempt),
    hardCloseMs: window.hardCloseMs
  });
  const late = nowMs > deadlineMs + (config.graceSeconds ?? 0) * 1000;

  const alreadyAccepted = priorSubmissions.some(
    (s) => s.outcome === SUBMISSION_OUTCOMES.ACCEPTED && s.testId === submission.testId
  );
  if (alreadyAccepted) {
    return { ...base, outcome: SUBMISSION_OUTCOMES.DUPLICATE, retained: true, late, deadlineMs };
  }

  return { ...base, outcome: SUBMISSION_OUTCOMES.ACCEPTED, retained: true, late, deadlineMs };
}
