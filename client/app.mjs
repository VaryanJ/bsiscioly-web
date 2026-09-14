/**
 * Static tryout client: DOM wiring only.
 *
 * Every rule (time, caps, identity shape, retries, image checks) lives in the tested
 * modules under src/. This file binds them to the page. There is NO live endpoint:
 * `?demo=1` runs against the in-memory mock with synthetic, already-stripped questions.
 * A real adapter is a separate, reviewed change (AGENTS.md rule 2).
 */

import { createAttemptClient, ATTEMPT_STATES } from '../src/client/attempt-client.mjs';
import { createMockEndpoint } from '../src/client/api-contract.mjs';
import { createHttpEndpoint } from '../src/client/http-endpoint.mjs';
import { ENDPOINT_URL } from './config.mjs';
import { createImageLoader, IMAGE_STATES } from '../src/client/image-loader.mjs';
import { validateIdentityFields, validateEmail, FIELD_PROBLEM } from '../src/client/identity.mjs';
import { formatAwayDuration } from '../src/client/away-time.mjs';
import { QUEUE_STATES } from '../src/client/submission-queue.mjs';
import { wallTimeToUtcMs } from '../src/policy/session-window.mjs';

const $ = (id) => document.getElementById(id);
const SESSION_TIME_ZONE = 'America/Phoenix';

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'role' || key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children);
  return node;
}

// Strip any code carried in the URL before anything else runs, so it never lands in
// history, a screenshot of the address bar, or a Referer (final-plan.md §5).
const params = new URLSearchParams(location.search);
const prefilledCode = params.get('code');
const demo = params.get('demo') === '1';
if (prefilledCode !== null || params.has('t')) {
  params.delete('code');
  params.delete('t');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
}

const REFUSAL_TEXT = {
  'bad-access-code': 'That code doesn’t open a test right now. Check it with your proctor.',
  'session-not-open': 'Testing with that code hasn’t opened yet. Codes change every testing day, so check you have today’s code.',
  'session-closed': 'Testing with that code has ended. Codes change every testing day, so check you have today’s code.',
  'late-start-closed': 'It’s too late today to start a new test. Ask your proctor.',
  'block-already-used': 'You’ve already taken a test in this time block today. Each block allows one test a day.',
  'session-cap-reached': 'You’ve already started two tests today, which is the daily limit.',
  'another-test-in-progress': 'You already have another test open. Finish and submit that test first, then start this one.',
  'not-on-roster': 'That name and grade aren’t on the tryout roster. Type your name the way the club has it, with your current grade, or ask your proctor.',
  'incomplete-identity': 'Check your first name, last name, and grade, then try again.',
  'test-not-ready': 'This test isn’t ready yet. Tell your proctor.',
  'resume-email-mismatch': 'This test was already started with this name and a different email. Enter the email you used when you started, or ask your proctor.',
  unreachable: 'Couldn’t reach the test server. Check your Wi-Fi and try again. If it keeps failing, tell your proctor.'
};

const FIELD_TEXT = {
  firstName: { [FIELD_PROBLEM.MISSING]: 'Enter your first name.', [FIELD_PROBLEM.TOO_LONG]: 'That first name is too long.' },
  lastName: { [FIELD_PROBLEM.MISSING]: 'Enter your last name.', [FIELD_PROBLEM.TOO_LONG]: 'That last name is too long.' },
  grade: { [FIELD_PROBLEM.MISSING]: 'Choose your grade.', [FIELD_PROBLEM.OUT_OF_RANGE]: 'Choose a grade from 6 to 12.' }
};

const EMAIL_TEXT = {
  missing: 'Enter your personal email.',
  malformed: 'Check your email address. It should look like name@example.com.'
};

async function loadDemoEndpoint() {
  const [config, artifact] = await Promise.all([
    fetch('../fixtures/synthetic-session.json').then((r) => r.json()),
    // Deliberately the pre-stripped artifact: even in a demo, the browser never receives keys.
    fetch('../fixtures/synthetic-image-student-artifact.json').then((r) => r.json())
  ]);
  const imageStore = { [artifact.slug]: {} };
  for (const image of artifact.images ?? []) {
    const bytes = new Uint8Array(await (await fetch(`../fixtures/synthetic-images/${image.id}.png`)).arrayBuffer());
    imageStore[artifact.slug][image.id] = { mimeType: 'image/png', bytes };
  }
  // Demo clock pinned inside the synthetic window, so the demo works on any day.
  const openedAt = wallTimeToUtcMs(config.date, '16:00', config.timeZone);
  const offset = openedAt - Date.now();
  const endpoint = createMockEndpoint({
    config,
    tests: { [artifact.slug]: artifact },
    accessCodes: { [artifact.slug]: 'DEMO' },
    clock: () => Date.now() + offset,
    imageStore
  });
  return endpoint;
}

// --- formatting -------------------------------------------------------------

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const formatClockTime = (ms) =>
  new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: SESSION_TIME_ZONE }).format(new Date(ms));

function formatList(numbers) {
  if (numbers.length <= 2) return numbers.join(' and ');
  return `${numbers.slice(0, -1).join(', ')}, and ${numbers.at(-1)}`;
}

function isAnswered(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

// --- entry ------------------------------------------------------------------

function setFieldError(id, message) {
  const note = $(`${id}-error`);
  note.textContent = message ?? '';
  note.hidden = !message;
  $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
}

function showEntryError(message) {
  $('entry-error').textContent = message ?? '';
  $('entry-error').hidden = !message;
}

function readIdentity() {
  return validateIdentityFields({ firstName: $('first-name').value, lastName: $('last-name').value, grade: $('grade').value });
}

/** Shows how the student will be entered, before they commit to it. */
function updateIdentityPreview() {
  const identity = readIdentity();
  $('identity-preview').hidden = !identity.valid;
  if (identity.valid) $('identity-display').textContent = identity.display;
}

const timesText = (count) => `${count} ${count === 1 ? 'time' : 'times'}`;

/** Informational only: shown so students know it is recorded, never used to score. */
function paintAway(client) {
  const away = client.awayTime();
  const line = $('clock-away');
  line.hidden = away.awayMs < 1000;
  if (!line.hidden) line.textContent = `Away from this test: ${formatAwayDuration(away.awayMs)} (${timesText(away.awayCount)})`;
}

// --- attempt ----------------------------------------------------------------

function showNotice(message, tone) {
  const notice = $('attempt-status');
  notice.className = `notice${tone ? ` notice-${tone}` : ''}`;
  notice.textContent = message ?? '';
  notice.hidden = !message;
}

const CLOCK_THRESHOLDS_MS = [300_000, 60_000];

/**
 * Paints the timer every tick, but speaks only when a threshold is first crossed.
 * A live region on the ticking numbers would make a screen reader talk twice a second.
 */
function createClockPainter(totalMs) {
  const announced = new Set();
  return (remainingMs) => {
    $('timer').textContent = formatRemaining(remainingMs);
    $('clock-fill').style.width = `${Math.max(0, Math.min(1, remainingMs / totalMs)) * 100}%`;
    $('clock').dataset.level = remainingMs <= 60_000 ? 'critical' : remainingMs <= 300_000 ? 'warn' : 'normal';
    const crossed = CLOCK_THRESHOLDS_MS.filter((t) => remainingMs > 0 && remainingMs <= t && !announced.has(t));
    if (crossed.length > 0) {
      crossed.forEach((t) => announced.add(t));
      const minutes = Math.ceil(remainingMs / 60_000);
      $('time-announcer').textContent = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} left.`;
    }
  };
}

const zoomHint = matchMedia('(pointer: coarse)').matches ? 'Tap image to zoom' : 'Click image to zoom';

function paintImage(figure, status, image, loader) {
  const img = figure.querySelector('img');
  const frame = figure.querySelector('.figure-frame');
  const state = figure.querySelector('.figure-state');
  figure.dataset.state = status.state;
  if (status.state === IMAGE_STATES.LOADED) {
    img.src = status.url;
    frame.disabled = false;
    state.replaceChildren(zoomHint);
  } else if (status.state === IMAGE_STATES.FAILED) {
    frame.disabled = true;
    const retry = h('button', { type: 'button', className: 'text-button', textContent: 'Try again' });
    retry.addEventListener('click', () => loader.retry(image.id));
    state.replaceChildren('Didn’t load. ', retry, '. If it keeps failing, tell your proctor.');
  } else {
    frame.disabled = true;
    state.replaceChildren('Loading…');
  }
}

function makeFigure(image, loader) {
  // Neutral label only: alt text must never describe what the image shows.
  const img = h('img', { alt: image.alt ?? image.label, width: image.width, height: image.height, decoding: 'async' });
  const frame = h('button', { type: 'button', className: 'figure-frame', 'aria-label': `Enlarge ${image.label}` }, img);
  frame.style.aspectRatio = `${image.width} / ${image.height}`;
  frame.addEventListener('click', () => openViewer(img.getAttribute('src'), image.label));
  const figure = h('figure', { className: 'figure', 'data-image-id': image.id },
    frame,
    h('figcaption', {}, h('span', { className: 'figure-label', textContent: image.label }), h('span', { className: 'figure-state' })));
  paintImage(figure, loader.status(image.id), image, loader);
  return figure;
}

let viewerZoom = 1;
function openViewer(src, label) {
  if (!src) return;
  $('viewer-image').src = src;
  $('viewer-image').alt = label;
  $('viewer-title').textContent = label;
  zoomViewer(0);
  $('image-viewer').showModal();
}

function zoomViewer(factor) {
  viewerZoom = factor === 0 ? 1 : Math.min(5, Math.max(1, viewerZoom * factor));
  $('viewer-image').style.width = `${viewerZoom * 100}%`;
}

function renderQuestions(artifact, client, loader, onAnswer) {
  const list = $('questions');
  list.replaceChildren();
  const items = new Map();

  artifact.questions.forEach((question, index) => {
    const stemId = `stem-${index + 1}`;
    const points = `${question.points} ${question.points === 1 ? 'point' : 'points'}`;
    const item = h('li', { className: 'question', 'data-answered': 'false' },
      h('div', { className: 'q-head' },
        h('span', { className: 'q-num', textContent: String(index + 1), 'aria-hidden': 'true' }),
        h('span', { className: 'q-points', textContent: points })),
      h('p', { className: question.type === 'symbolic' ? 'stem typed' : 'stem', id: stemId, textContent: question.prompt }));

    for (const imageId of question.image_ids ?? []) {
      const image = artifact.images.find((entry) => entry.id === imageId);
      if (image) item.append(makeFigure(image, loader));
    }

    if (question.type === 'mcq') {
      const group = h('div', { className: 'choices', role: question.allow_multiple ? 'group' : 'radiogroup', 'aria-labelledby': stemId });
      if (question.allow_multiple) item.append(h('p', { className: 'hint', textContent: 'Select all that apply.' }));
      question.choices.forEach((choice, choiceIndex) => {
        const input = h('input', {
          type: question.allow_multiple ? 'checkbox' : 'radio',
          name: question.id, value: String(choiceIndex), className: 'choice-input'
        });
        input.addEventListener('change', () => {
          const selected = [...group.querySelectorAll('input:checked')].map((el) => Number(el.value));
          client.setAnswer(question.id, question.allow_multiple ? selected : selected[0]);
          onAnswer();
        });
        group.append(h('label', { className: 'choice' },
          input,
          h('span', { className: question.allow_multiple ? 'bubble square' : 'bubble', textContent: String.fromCharCode(65 + choiceIndex) }),
          h('span', { className: 'choice-text', textContent: choice })));
      });
      item.append(group);
    } else {
      // A decoded message can run to several lines, so typed answers get a box, not a one-line field.
      const field = question.type === 'frq' || question.type === 'symbolic' ? h('textarea', { rows: question.type === 'frq' ? 5 : 3 }) : h('input', { type: 'text' });
      field.className = question.type === 'symbolic' ? 'answer-input typed-answer' : 'answer-input';
      field.placeholder = 'Your answer';
      field.setAttribute('aria-labelledby', stemId);
      field.setAttribute('autocomplete', 'off');
      // Autocorrect rewrites scientific terms and units into wrong words.
      field.setAttribute('autocorrect', 'off');
      field.setAttribute('autocapitalize', 'off');
      field.spellcheck = false;
      field.addEventListener('input', () => { client.setAnswer(question.id, field.value); onAnswer(); });
      // Enter in a one-line answer must not submit the whole test.
      if (field.tagName === 'INPUT') field.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault(); });
      item.append(field);
    }

    items.set(question.id, item);
    list.append(item);
  });
  return items;
}

function refreshProgress(artifact, client, items) {
  const answers = client.answers;
  const missing = [];
  artifact.questions.forEach((question, index) => {
    const answered = isAnswered(answers[question.id]);
    items.get(question.id).dataset.answered = String(answered);
    if (!answered) missing.push(index + 1);
  });
  const total = artifact.questions.length;
  const answered = total - missing.length;
  $('progress').textContent = `${answered} of ${total} answered`;
  $('progress-missing').textContent = missing.length === 0
    ? 'Every question has an answer.'
    : missing.length > 12 ? `${missing.length} questions have no answer yet.` : `No answer yet: ${formatList(missing)}.`;
  return { answered, total, missing };
}

function finish(client, artifact) {
  $('clock').hidden = true;
  $('attempt').hidden = true;
  $('done').hidden = false;
  if (client.state === ATTEMPT_STATES.EXPIRED) {
    $('done').dataset.tone = 'bad';
    $('done-title').textContent = 'Time is up for this test';
    $('done-detail').textContent = 'Time ran out before this page opened, and this device has none of your answers.';
    $('done-next').textContent = 'If you answered on another device, open the test there so it can send your answers. Otherwise, tell your proctor.';
    $('done-retry').hidden = true;
  } else if (client.state === ATTEMPT_STATES.COMPLETE) {
    const receiptMs = client.queue.receipt?.receiptMs;
    $('done').dataset.tone = 'ok';
    $('done-title').textContent = 'Answers submitted';
    $('done-detail').textContent = receiptMs
      ? `Your answers for ${artifact.event} were received at ${formatClockTime(receiptMs)}.`
      : `Your answers for ${artifact.event} were received.`;
    // Status only. The student never sees a score or whether any answer was correct.
    $('done-next').textContent = 'You can close this page. Scores aren’t shown here.';
    $('done-retry').hidden = true;
  } else {
    const saved = !client.queue.history.some((event) => event.type === 'persist-failed');
    $('done').dataset.tone = 'bad';
    $('done-title').textContent = 'Not submitted yet';
    $('done-detail').textContent = client.queue.statusText();
    $('done-next').textContent = saved ? 'Your answers are saved on this device.' : 'Keep this page open.';
    $('done-retry').hidden = client.queue.state !== QUEUE_STATES.EXHAUSTED;
  }
  const away = client.awayTime();
  $('done-away').textContent = away.awayMs < 1000
    ? 'Time away from this test: none.'
    : `Time away from this test: ${formatAwayDuration(away.awayMs)} (${timesText(away.awayCount)}).`;
  window.scrollTo(0, 0);
  $('done-title').focus();
}

function beginAttempt({ result, client, endpoint }) {
  const artifact = result.artifact;
  // The server sets each attempt's length, so the bar follows it rather than the test file's nominal time.
  const totalMs = result.attemptMs > 0 ? result.attemptMs : (artifact.time_limit_minutes ?? 25) * 60_000;
  $('entry').hidden = true;
  $('attempt').hidden = false;
  $('clock').hidden = false;
  $('clock-event').textContent = artifact.event;
  document.title = `${artifact.event} – Tryout test`;

  const loader = createImageLoader({ endpoint, attemptId: client.attemptId, images: artifact.images ?? [] });
  let items;
  const onAnswer = () => refreshProgress(artifact, client, items);
  items = renderQuestions(artifact, client, loader, onAnswer);
  showSavedAnswers(artifact, client, items);
  onAnswer();
  if (result.restoredAnswers > 0) showNotice('Welcome back. Your answers on this device are restored, and your timer kept running.');
  loader.onChange((imageId, status) => {
    const image = artifact.images.find((entry) => entry.id === imageId);
    // All figures, not the first: one image can illustrate several questions.
    for (const figure of document.querySelectorAll(`figure[data-image-id="${CSS.escape(imageId)}"]`)) {
      paintImage(figure, status, image, loader);
    }
  });
  loader.loadAll();
  window.scrollTo(0, 0);
  $('clock-event').focus();

  const paintClock = createClockPainter(totalMs);
  const freeze = () => {
    $('answers-fieldset').disabled = true;
    $('submit-button').disabled = true;
  };

  const checkClock = async () => {
    // Heartbeat only while the student is actually on the page, so a reload can tell how long it was closed.
    if (document.visibilityState === 'visible' && document.hasFocus()) client.activity.heartbeat();
    paintAway(client);
    paintClock(client.remainingMs());
    if (client.isExpired() && client.state === ATTEMPT_STATES.RUNNING) {
      stopClock();
      freeze();
      if ($('review').open) $('review').close();
      $('time-announcer').textContent = 'Time’s up. Your answers are being submitted.';
      showNotice('Time’s up. Your answers are locked and being submitted.', 'warn');
      await client.tick();
      finish(client, artifact);
    }
  };
  // Browsers slow repeating timers in a background tab to as little as once a minute. A single
  // timer set for the deadline is not slowed that way, and coming back to the page, waking the
  // device, or reconnecting checks the clock at once.
  const timer = setInterval(checkClock, 500);
  const deadlineTimer = setTimeout(checkClock, Math.min(client.remainingMs() + 250, 2 ** 31 - 1));
  const wake = () => { if (document.visibilityState === 'visible') checkClock(); };
  const wakeEvents = [[document, 'visibilitychange'], [window, 'focus'], [window, 'pageshow'], [window, 'online']];
  for (const [target, type] of wakeEvents) target.addEventListener(type, wake);
  // Closing or reloading mid-test asks first. Answers are saved on this device either way.
  const warnBeforeLeaving = (event) => {
    if (client.state === ATTEMPT_STATES.RUNNING || client.state === ATTEMPT_STATES.SUBMITTING) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', warnBeforeLeaving);
  function stopClock() {
    clearInterval(timer);
    clearTimeout(deadlineTimer);
    for (const [target, type] of wakeEvents) target.removeEventListener(type, wake);
  }
  paintClock(client.remainingMs());
  paintAway(client);

  $('answers').addEventListener('submit', (event) => {
    event.preventDefault();
    const { answered, total, missing } = refreshProgress(artifact, client, items);
    $('review-summary').textContent = missing.length === 0
      ? `You’ve answered all ${total} questions.`
      : `You’ve answered ${answered} of ${total} questions. ${missing.length > 12 ? `${missing.length} have no answer.` : `No answer yet: ${formatList(missing)}.`}`;
    $('review').showModal();
  });
  $('review-cancel').addEventListener('click', () => $('review').close());
  $('review-confirm').addEventListener('click', async () => {
    $('review').close();
    stopClock();
    freeze();
    showNotice('Submitting your answers…');
    await client.submit();
    finish(client, artifact);
  });
  $('done-retry').addEventListener('click', async () => {
    $('done-retry').disabled = true;
    await client.submit(); // same submission id: the server treats a resend as a replay
    $('done-retry').disabled = false;
    finish(client, artifact);
  });
  // Back online after sending gave up: try again without waiting for the button.
  window.addEventListener('online', async () => {
    if (client.state !== ATTEMPT_STATES.SUBMITTING || client.queue.state !== QUEUE_STATES.EXHAUSTED) return;
    await client.submit();
    finish(client, artifact);
  });
}

/** Shows answers restored from this device on the rendered questions. */
function showSavedAnswers(artifact, client, items) {
  const saved = client.answers;
  for (const question of artifact.questions) {
    const value = saved[question.id];
    if (value === undefined || value === null) continue;
    const item = items.get(question.id);
    if (question.type === 'mcq') {
      const chosen = new Set([].concat(value).map(Number));
      for (const input of item.querySelectorAll('input.choice-input')) input.checked = chosen.has(Number(input.value));
    } else {
      const field = item.querySelector('.answer-input');
      if (field) field.value = String(value);
    }
  }
}

async function main() {
  // ?demo=1 always means the in-page stand-in, even once a real server is configured, so
  // the demo can never touch real records.
  let endpoint;
  if (demo) {
    endpoint = await loadDemoEndpoint();
    $('demo-notice').hidden = false;
  } else if (ENDPOINT_URL) {
    endpoint = createHttpEndpoint({ url: ENDPOINT_URL });
  } else {
    showEntryError('No test server is set up for this page yet. Open it with ?demo=1 to try the demo.');
    $('start-button').disabled = true;
    return;
  }
  if (prefilledCode) $('access-code').value = prefilledCode.toUpperCase();

  const client = createAttemptClient({ endpoint, storage: window.localStorage });
  client.activity.attach({ documentRef: document, windowRef: window });

  $('viewer-close').addEventListener('click', () => $('image-viewer').close());
  $('zoom-in').addEventListener('click', () => zoomViewer(1.5));
  $('zoom-out').addEventListener('click', () => zoomViewer(1 / 1.5));
  $('zoom-reset').addEventListener('click', () => zoomViewer(0));

  for (const id of ['first-name', 'last-name', 'grade']) {
    $(id).addEventListener(id === 'grade' ? 'change' : 'input', () => { updateIdentityPreview(); setFieldError(id, null); });
  }
  $('access-code').addEventListener('input', () => setFieldError('access-code', null));
  $('email').addEventListener('input', () => setFieldError('email', null));

  $('entry-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showEntryError(null);

    const code = $('access-code').value.trim().toUpperCase();
    const identity = readIdentity();
    const email = validateEmail($('email').value);
    const problems = identity.valid ? {} : identity.problems;
    setFieldError('access-code', code ? null : 'Enter the access code from your proctor.');
    setFieldError('first-name', problems.firstName ? FIELD_TEXT.firstName[problems.firstName] : null);
    setFieldError('last-name', problems.lastName ? FIELD_TEXT.lastName[problems.lastName] : null);
    setFieldError('grade', problems.grade ? FIELD_TEXT.grade[problems.grade] : null);
    setFieldError('email', email.valid ? null : EMAIL_TEXT[email.problem]);
    const firstInvalid = [!code && 'access-code', problems.firstName && 'first-name', problems.lastName && 'last-name', problems.grade && 'grade', !email.valid && 'email'].find(Boolean);
    if (firstInvalid) {
      $(firstInvalid).focus();
      return;
    }

    const button = $('start-button');
    button.disabled = true;
    button.textContent = 'Starting…';
    let result;
    try {
      // Only what the student typed. The server decides the test, the roster match, and the start time.
      result = await client.start({
        accessCode: code,
        firstName: identity.firstName,
        lastName: identity.lastName,
        grade: identity.grade,
        email: email.email
      }, { onRetry: () => { button.textContent = 'Server busy, trying again…'; } });
    } catch (error) {
      result = { ok: false, reason: 'unreachable' };
    }
    button.disabled = false;
    button.textContent = 'Start test';
    if (!result.ok) {
      showEntryError(REFUSAL_TEXT[result.reason] ?? `This test couldn’t start (${result.reason}). Show this screen to your proctor.`);
      return;
    }
    if (client.hasPendingSubmission) {
      // Submitted on this device before, but not confirmed. Send those answers, not a new set.
      $('entry').hidden = true;
      await client.resendPending();
      finish(client, result.artifact);
      return;
    }
    beginAttempt({ result, client, endpoint });
  });
}

main();
