/**
 * Owner/coach extensions.
 *
 * Every grant produces an audit record with a named grantor and a written reason. This
 * mirrors the override discipline in `goals.md` §6.2 and `AGENTS.md` rule 7: a change
 * that affects a student's outcome is never anonymous and never silent.
 *
 * An extension can only ever move a deadline later within the session. The hard close
 * caps it absolutely, so no grant — or sequence of grants — can run a student past it.
 */

import { computeDeadlineMs, grantedExtensionMinutes } from './attempt-policy.mjs';

export const EXTENSION_ROLES = Object.freeze(['owner', 'coach']);

export const EXTENSION_REFUSAL = {
  UNAUTHORIZED_ROLE: 'unauthorized-role',
  MISSING_REASON: 'missing-reason',
  NO_ATTEMPT: 'no-attempt',
  AFTER_HARD_CLOSE: 'after-hard-close',
  ALREADY_AT_HARD_CLOSE: 'already-at-hard-close',
  EXTENSION_LIMIT_REACHED: 'extension-limit-reached'
};

const MIN_REASON_LENGTH = 4;

/**
 * Decide whether to grant one extension, and produce its audit record.
 *
 * Returns `{ granted: false, reason }` or `{ granted: true, record, deadlineBeforeMs,
 * deadlineAfterMs }`. The caller appends `record` to the attempt's `extensions`.
 */
export function authorizeExtension({ window, config, attempt, grantedBy, grantedByRole, reason, nowMs }) {
  const refuse = (code) => ({ granted: false, reason: code });

  if (!EXTENSION_ROLES.includes(grantedByRole)) return refuse(EXTENSION_REFUSAL.UNAUTHORIZED_ROLE);
  if (typeof grantedBy !== 'string' || grantedBy.trim() === '') return refuse(EXTENSION_REFUSAL.UNAUTHORIZED_ROLE);
  if (typeof reason !== 'string' || reason.trim().length < MIN_REASON_LENGTH) {
    return refuse(EXTENSION_REFUSAL.MISSING_REASON);
  }
  if (!attempt || attempt.firstDeliveryMs === undefined) return refuse(EXTENSION_REFUSAL.NO_ATTEMPT);
  if (nowMs > window.hardCloseMs) return refuse(EXTENSION_REFUSAL.AFTER_HARD_CLOSE);

  const existing = attempt.extensions ?? [];
  const limit = config.maxExtensionsPerAttempt ?? null;
  if (limit !== null && existing.length >= limit) return refuse(EXTENSION_REFUSAL.EXTENSION_LIMIT_REACHED);

  const deadlineBeforeMs = computeDeadlineMs({
    firstDeliveryMs: attempt.firstDeliveryMs,
    attemptMinutes: config.attemptMinutes,
    extensionMinutesTotal: grantedExtensionMinutes(attempt),
    hardCloseMs: window.hardCloseMs
  });

  // Already pinned to the hard close: granting would log an extension that changes
  // nothing. Refuse explicitly so the proctor looks for another remedy (paper, makeup
  // window) instead of believing time was added.
  if (deadlineBeforeMs >= window.hardCloseMs) return refuse(EXTENSION_REFUSAL.ALREADY_AT_HARD_CLOSE);

  const minutes = config.extensionMinutes;
  const deadlineAfterMs = computeDeadlineMs({
    firstDeliveryMs: attempt.firstDeliveryMs,
    attemptMinutes: config.attemptMinutes,
    extensionMinutesTotal: grantedExtensionMinutes(attempt) + minutes,
    hardCloseMs: window.hardCloseMs
  });

  return {
    granted: true,
    deadlineBeforeMs,
    deadlineAfterMs,
    // Capped grants are visible as a shortfall rather than being rounded away.
    effectiveMinutes: (deadlineAfterMs - deadlineBeforeMs) / 60_000,
    record: {
      minutes,
      grantedBy,
      grantedByRole,
      reason: reason.trim(),
      grantedAtMs: nowMs,
      testId: attempt.testId,
      identityKey: attempt.identityKey,
      deadlineBeforeMs,
      deadlineAfterMs
    }
  };
}

/** Append a granted extension to an attempt without mutating the original. */
export function applyExtension(attempt, record) {
  return { ...attempt, extensions: [...(attempt.extensions ?? []), record] };
}
