/**
 * Time a student spent away from the test page, computed from the ordered activity log.
 *
 * Shown to the student and saved for the owner. It is informational only: goals.md §2
 * says tab logging is not load-bearing with a proctor in the room, and a phone can report
 * a blur for reasons that have nothing to do with cheating. Nothing may score it.
 *
 * "Away" means any of: the page was hidden, the window lost focus, or the page was closed.
 * Overlapping causes are counted once, not added together.
 */

/** Away stretches shorter than this still add to the total but not to the count. */
export const MIN_COUNTED_AWAY_MS = 1000;

export function computeAwayTime(events, { startMs, endMs }) {
  let hidden = false;
  let blurred = false;
  let closed = false;
  let awaySince = null;
  let awayMs = 0;
  let awayCount = 0;
  const isAway = () => hidden || blurred || closed;

  const settle = (atMs) => {
    const from = Math.max(awaySince, startMs);
    const to = Math.min(atMs, endMs);
    if (to > from) {
      awayMs += to - from;
      if (to - from >= MIN_COUNTED_AWAY_MS) awayCount += 1;
    }
    awaySince = null;
  };

  // Stable sort: events recorded at the same millisecond keep their recorded order.
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs);
  for (const event of ordered) {
    if (event.atMs > endMs) break;
    const wasAway = isAway();
    switch (event.type) {
      case 'hidden': hidden = true; break;
      case 'visible': hidden = false; break;
      case 'blur': blurred = true; break;
      case 'focus': blurred = false; break;
      case 'closed': closed = true; break;
      // A freshly opened page is visible and focused, whatever the old page last reported.
      case 'reopened': closed = false; hidden = false; blurred = false; break;
      default: continue;
    }
    const nowAway = isAway();
    if (!wasAway && nowAway) awaySince = event.atMs;
    else if (wasAway && !nowAway) settle(event.atMs);
  }
  const awayNow = isAway();
  if (awaySince !== null) settle(endMs);

  return { awayMs, awaySeconds: Math.round(awayMs / 1000), awayCount, awayNow };
}

export function formatAwayDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
