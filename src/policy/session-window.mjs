/**
 * Session window arithmetic for a tryout session, in the session's own time zone.
 *
 * All boundaries are computed from a wall-clock configuration (`2026-09-15`, `15:45`,
 * `America/Phoenix`) rather than stored as UTC instants, because the owner reasons in
 * local time and a hand-converted UTC offset is exactly the kind of silent error that
 * would open or close a test an hour off.
 *
 * Phoenix does not observe DST, but nothing here assumes that: the offset is resolved
 * from the IANA zone at the instant in question, so a session configured in a
 * DST-observing zone is still correct.
 */

/** Offset, in ms, that must be added to a UTC instant to get local wall time. */
function zoneOffsetMs(utcMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asIfUtc - utcMs;
}

/**
 * The UTC instant for a local wall-clock time in `timeZone`.
 * Two passes, because the offset itself depends on the instant we are solving for.
 */
export function wallTimeToUtcMs(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split('-').map(Number);
  const [hour, minute] = timeText.split(':').map(Number);
  if ([year, month, day, hour, minute].some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid session date/time: ${dateText} ${timeText}`);
  }
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstPass = naive - zoneOffsetMs(naive, timeZone);
  const secondPass = naive - zoneOffsetMs(firstPass, timeZone);
  return secondPass;
}

export function formatInZone(utcMs, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: true, hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }).format(new Date(utcMs));
}

/** Resolve a session configuration into absolute UTC boundaries. */
export function resolveSessionWindow(config) {
  const { timeZone, date, opensAt, lastNormalStartAt, hardCloseAt } = config;
  const window = {
    sessionId: config.sessionId,
    timeZone,
    opensAtMs: wallTimeToUtcMs(date, opensAt, timeZone),
    lastNormalStartMs: wallTimeToUtcMs(date, lastNormalStartAt, timeZone),
    hardCloseMs: wallTimeToUtcMs(date, hardCloseAt, timeZone)
  };

  if (!(window.opensAtMs <= window.lastNormalStartMs && window.lastNormalStartMs <= window.hardCloseMs)) {
    throw new Error('Session window must satisfy opensAt <= lastNormalStart <= hardClose.');
  }
  // A start permitted at lastNormalStart must be able to run a full attempt before the
  // hard close, or the configuration silently truncates the last students' tests.
  const fullAttemptMs = config.attemptMinutes * 60_000;
  window.lastStartLeavesFullAttempt = window.lastNormalStartMs + fullAttemptMs <= window.hardCloseMs;
  return window;
}

export const SESSION_PHASES = { BEFORE_OPEN: 'before-open', OPEN: 'open', LATE_START_CLOSED: 'late-start-closed', CLOSED: 'closed' };

/**
 * Where `nowMs` sits relative to the session.
 *
 * `late-start-closed` is the interval between the last normal start and the hard close:
 * running attempts continue, but no new attempt may begin.
 */
export function sessionPhase(window, nowMs) {
  if (nowMs < window.opensAtMs) return SESSION_PHASES.BEFORE_OPEN;
  if (nowMs > window.hardCloseMs) return SESSION_PHASES.CLOSED;
  if (nowMs > window.lastNormalStartMs) return SESSION_PHASES.LATE_START_CLOSED;
  return SESSION_PHASES.OPEN;
}
