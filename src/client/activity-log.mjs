/**
 * Ordered visibility/focus activity log.
 *
 * `goals.md` §2 is explicit that this is near-redundant with a proctor in the room and
 * is not load-bearing evidence. It is cheap to keep on record, so it is kept — and it is
 * deliberately dumb: it records what the browser reported, with no interpretation and no
 * scoring. Nothing downstream should treat a tab-out as proof of anything.
 */

// `closed`/`reopened` bracket the time a resumed attempt's page was not open at all.
// `fullscreen-exit`/`fullscreen-enter` bracket time out of full screen, on a device that has it.
export const ACTIVITY_EVENTS = Object.freeze(['visible', 'hidden', 'focus', 'blur', 'closed', 'reopened', 'fullscreen-exit', 'fullscreen-enter']);

const HEARTBEAT_EVERY_MS = 5_000;
const CLOSED_GAP_MIN_MS = 2_000;

export function createActivityLog({ clock = () => Date.now(), limit = 500 } = {}) {
  const events = [];
  let persistence = null;
  let lastSeenMs = null;

  function save() {
    if (!persistence) return;
    try {
      persistence.storage.setItem(persistence.key, JSON.stringify({ events, lastSeenMs }));
    } catch {
      // Storage blocked or full: the in-memory log still goes out with the submission.
    }
  }

  function record(type, atMs = clock()) {
    if (!ACTIVITY_EVENTS.includes(type)) throw new Error(`Unknown activity event: ${type}`);
    // Keep the earliest events: the start of an attempt is more informative than a long
    // tail, and an unbounded array on a cheap phone is its own failure mode.
    if (events.length >= limit) return { dropped: true };
    events.push({ type, atMs });
    save();
    return { dropped: false };
  }

  /**
   * Attach to a DOM document/window pair. Returns a detach function.
   * Split from `record` so the log is fully testable with no DOM.
   */
  function attach({ documentRef, windowRef }) {
    const onVisibility = () => record(documentRef.visibilityState === 'visible' ? 'visible' : 'hidden');
    const onFocus = () => record('focus');
    const onBlur = () => record('blur');

    documentRef.addEventListener('visibilitychange', onVisibility);
    windowRef.addEventListener('focus', onFocus);
    windowRef.addEventListener('blur', onBlur);

    return function detach() {
      documentRef.removeEventListener('visibilitychange', onVisibility);
      windowRef.removeEventListener('focus', onFocus);
      windowRef.removeEventListener('blur', onBlur);
    };
  }

  /**
   * Keep this attempt's log across reloads on this device. For a resumed attempt, restore
   * the earlier page's events and record the stretch the page was not open as away time,
   * from the last moment the student was seen on it to when this page opened.
   */
  function persistTo(storage, key, { resumed = false, reopenedAtMs = clock() } = {}) {
    if (!storage) return { restored: 0, closedMs: 0 };
    let prior = null;
    try {
      prior = JSON.parse(storage.getItem(key) ?? 'null');
    } catch {
      prior = null;
    }
    persistence = { storage, key };
    let closedMs = 0;
    let restored = 0;
    if (resumed && Array.isArray(prior?.events)) {
      const thisPage = events.splice(0, events.length);
      events.push(...prior.events);
      restored = prior.events.length;
      const lastSeen = Math.max(prior.lastSeenMs ?? 0, prior.events.at(-1)?.atMs ?? 0);
      if (lastSeen > 0 && reopenedAtMs - lastSeen >= CLOSED_GAP_MIN_MS) {
        events.push({ type: 'closed', atMs: lastSeen }, { type: 'reopened', atMs: reopenedAtMs });
        closedMs = reopenedAtMs - lastSeen;
      }
      events.push(...thisPage);
      events.splice(limit);
    }
    save();
    return { restored, closedMs };
  }

  /** Call while the student is on the page; throttled so storage is written every few seconds. */
  function heartbeat(atMs = clock()) {
    if (lastSeenMs !== null && atMs - lastSeenMs < HEARTBEAT_EVERY_MS) return false;
    lastSeenMs = atMs;
    save();
    return true;
  }

  return {
    record,
    attach,
    persistTo,
    heartbeat,
    get events() { return [...events]; },
    summary() {
      const counts = Object.fromEntries(ACTIVITY_EVENTS.map((type) => [type, 0]));
      for (const event of events) counts[event.type] += 1;
      return { counts, total: events.length, firstMs: events[0]?.atMs ?? null, lastMs: events.at(-1)?.atMs ?? null };
    }
  };
}
