/**
 * The client/server contract, plus an in-memory mock adapter.
 *
 * No live endpoint, no network, no deployment. The mock enforces the same policy
 * functions the real endpoint will, so the client can be driven end-to-end in tests
 * before any server exists (`AGENTS.md` rule 2).
 */

import { resolveSessionWindow } from '../policy/session-window.mjs';
import { authorizeStart, authorizeSubmission, START_DECISIONS, SUBMISSION_OUTCOMES } from '../policy/attempt-policy.mjs';
import { authorizeExtension, applyExtension } from '../policy/extension.mjs';
import { authorizeImageFetch } from '../policy/image-policy.mjs';
import { bytesToBase64 } from './bytes.mjs';
import { computeAwayTime } from './away-time.mjs';
import { validateIdentityFields } from './identity.mjs';

/**
 * Fields a student's browser is allowed to receive.
 *
 * This is an ALLOWLIST, not a denylist: a field added to the test schema later is
 * withheld by default rather than leaked by default. Getting this backwards would ship
 * answer keys to every device in the room.
 */
export const STUDENT_VISIBLE_QUESTION_FIELDS = Object.freeze(['id', 'type', 'prompt', 'points', 'choices', 'allow_multiple', 'image_ids']);
/** Image metadata only. The bytes travel separately, after authorization; storage paths never do. */
export const STUDENT_VISIBLE_IMAGE_FIELDS = Object.freeze(['id', 'label', 'alt', 'width', 'height', 'bytes', 'sha256']);
export const STUDENT_VISIBLE_TEST_FIELDS = Object.freeze(['event', 'slug', 'time_limit_minutes']);

/** Grading metadata that must never appear in a student artifact. */
export const PROTECTED_FIELDS = Object.freeze([
  'correct', 'correct_value', 'tolerance', 'tolerance_type', 'units',
  'accepted_answers', 'case_sensitive', 'rubric', 'hint_keywords',
  'verified', 'verified_by', 'note',
  // Image storage and provenance: a path or crop record can name the source or the answer.
  'file', 'source_pdf', 'source_page', 'crop',
  // Authoring and release records: who wrote or approved a question, and the hash they approved.
  'origin', 'review_class', 'drafted_by', 'verified_content_sha256', 'owner_delegation'
]);

export function toStudentArtifact(test) {
  const artifact = {};
  for (const field of STUDENT_VISIBLE_TEST_FIELDS) {
    if (field in test) artifact[field] = test[field];
  }
  artifact.questions = test.questions.map((question) => {
    const visible = {};
    for (const field of STUDENT_VISIBLE_QUESTION_FIELDS) {
      if (field in question) visible[field] = question[field];
    }
    return visible;
  });
  if (Array.isArray(test.images)) {
    artifact.images = test.images.map((image) => {
      const visible = {};
      for (const field of STUDENT_VISIBLE_IMAGE_FIELDS) {
        if (field in image) visible[field] = image[field];
      }
      return visible;
    });
  }
  return artifact;
}

/** Throws if any protected grading field survived into a student-facing payload. */
export function assertNoProtectedFields(value, path = 'artifact') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoProtectedFields(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (PROTECTED_FIELDS.includes(key)) {
      throw new Error(`Protected field "${key}" reached a student artifact at ${path}`);
    }
    assertNoProtectedFields(nested, `${path}.${key}`);
  }
}

/**
 * The wire contract every endpoint speaks: this in-memory stand-in, the HTTP connection to
 * the deployed server (http-endpoint.mjs), and apps-script/Server.gs.
 *
 * It follows the server, because the server is the authority. A student sends only what
 * they typed; the server decides which test a code opens, which roster row a name is, and
 * when their time started. test/contract-parity.test.mjs fails if the stand-in and the
 * real server ever return different fields.
 *
 *   start   { accessCode, firstName, lastName, grade, email }
 *        -> { ok: true, decision, attemptId, testId, event, serverNowMs, firstDeliveryMs, deadlineMs, artifact }
 *        |  { ok: false, decision: 'refused', reason }
 *   submit  { attemptId, submissionId, answers, activity, clientSubmittedAtMs, clientServerNowMs, auto }
 *        -> { ok: true, outcome, receiptId, late, receiptMs }
 *   images  { attemptId, imageIds }
 *        -> { ok: true, images } | { ok: false, reason }
 */
export const START_RESPONSE_FIELDS = Object.freeze(['ok', 'decision', 'attemptId', 'testId', 'event', 'serverNowMs', 'firstDeliveryMs', 'deadlineMs', 'artifact']);
export const SUBMIT_RESPONSE_FIELDS = Object.freeze(['ok', 'outcome', 'receiptId', 'late', 'receiptMs']);

/**
 * In-memory stand-in for the deployed Apps Script endpoint.
 *
 * Holds the protected side (tests with keys, access codes, attempt records) and never
 * returns any of it. `clock` is injected so tests control time exactly. `blocks` maps a
 * test id to its conflict block, which the server reads from the Tests tab.
 */
export function createMockEndpoint({ config, tests, accessCodes, blocks = {}, clock, imageStore = {}, failFor = () => null }) {
  const window = resolveSessionWindow(config);
  const attempts = [];
  const submissions = [];
  const extensionLog = [];
  let nextAttempt = 1;
  let nextReceipt = 1;

  const byAttemptId = (attemptId) => attempts.find((attempt) => attempt.attemptId === attemptId);
  const testForCode = (code) => {
    const wanted = String(code ?? '').trim().toUpperCase();
    return Object.keys(accessCodes).find((testId) => String(accessCodes[testId]).toUpperCase() === wanted) ?? null;
  };

  return {
    window,
    /** Test-only inspection of protected state; never exposed over the wire. */
    _state: () => ({ attempts, submissions, extensionLog }),

    async startAttempt({ accessCode, firstName, lastName, grade, email }) {
      const forced = failFor('startAttempt');
      if (forced) throw forced;
      const nowMs = clock();

      const identity = validateIdentityFields({ firstName, lastName, grade });
      if (!identity.valid) return { ok: false, decision: START_DECISIONS.REFUSED, reason: 'incomplete-identity' };

      // An unknown code refuses the same way as any other bad code, so it reveals nothing.
      const testId = testForCode(accessCode);
      if (!testId) return { ok: false, decision: START_DECISIONS.REFUSED, reason: 'bad-access-code' };

      const result = authorizeStart({
        window,
        config,
        request: { identityKey: identity.canonical, testId, blockId: blocks[testId] ?? 1, accessCodeValid: true },
        priorAttempts: attempts,
        nowMs
      });
      if (result.decision === START_DECISIONS.REFUSED) {
        return { ok: false, decision: result.decision, reason: result.reason };
      }

      // Reopening hands over the attempt id, so it needs the email typed at the start too:
      // a classmate's name and grade are easy to know (Server.gs, resumeAllowed_).
      const typedEmail = String(email ?? '').trim().toLowerCase();
      let attempt = result.attempt;
      if (result.decision === START_DECISIONS.RESUMED && attempt.email && attempt.email !== typedEmail) {
        return { ok: false, decision: START_DECISIONS.REFUSED, reason: 'resume-email-mismatch' };
      }
      if (result.decision === START_DECISIONS.AUTHORIZED) {
        attempt = { ...result.attempt, attemptId: `A${nextAttempt++}`, email: typedEmail };
        attempts.push(attempt);
      }

      const artifact = toStudentArtifact(tests[testId]);
      assertNoProtectedFields(artifact); // belt and braces: fail loudly rather than leak
      return {
        ok: true,
        decision: result.decision,
        attemptId: attempt.attemptId,
        testId,
        event: tests[testId].event,
        serverNowMs: nowMs,
        firstDeliveryMs: result.firstDeliveryMs,
        deadlineMs: result.deadlineMs,
        artifact
      };
    },

    async submitAttempt(payload) {
      const forced = failFor('submitAttempt');
      if (forced) throw forced;
      if (!payload?.submissionId) throw Object.assign(new Error('rejected-malformed'), { retryable: false });

      const nowMs = clock();
      const attempt = byAttemptId(payload.attemptId);
      const submission = { ...payload, testId: attempt?.testId };
      const receipt = authorizeSubmission({
        window, config, attempt, submission,
        priorSubmissions: submissions.filter((s) => s.attemptId === payload.attemptId),
        nowMs
      });

      if (receipt.outcome === SUBMISSION_OUTCOMES.REPLAY) {
        return { ok: true, outcome: receipt.outcome, receiptId: receipt.receiptId, late: receipt.late, receiptMs: receipt.receiptMs };
      }

      // Away time recomputed here from the raw events, not taken from the phone. Events carry
      // device-clock times, so convert the attempt window into that clock.
      const offsetMs = (payload.clientServerNowMs ?? nowMs) - (payload.clientSubmittedAtMs ?? nowMs);
      const away = attempt
        ? computeAwayTime(payload.activity ?? [], {
          startMs: attempt.firstDeliveryMs - offsetMs,
          endMs: Math.min(payload.clientSubmittedAtMs ?? nowMs - offsetMs, (receipt.deadlineMs ?? Infinity) - offsetMs)
        })
        : null;
      const receiptId = `R${nextReceipt++}`;
      submissions.push({ ...receipt, receiptId, attemptId: payload.attemptId, identityKey: attempt?.identityKey, answers: payload.answers, activity: payload.activity, away });
      // A receipt carries status only — never a score, never correctness.
      return { ok: true, outcome: receipt.outcome, receiptId, late: receipt.late, receiptMs: receipt.receiptMs };
    },

    /** Image bytes for a started attempt only; see image-policy.mjs. */
    async getImages({ attemptId, imageIds }) {
      const forced = failFor('getImages');
      if (forced) throw forced;
      const nowMs = clock();
      const attempt = byAttemptId(attemptId);
      const test = attempt ? tests[attempt.testId] : null;
      const decision = authorizeImageFetch({ window, config, attempt, test, imageIds, nowMs });
      if (!decision.authorized) return { ok: false, reason: decision.reason };
      return {
        ok: true,
        images: imageIds.map((id) => {
          const stored = imageStore[attempt.testId]?.[id];
          return stored ? { id, mimeType: stored.mimeType, dataBase64: bytesToBase64(stored.bytes) } : { id, missing: true };
        })
      };
    },

    async grantExtension({ attemptId, grantedBy, grantedByRole, reason }) {
      const nowMs = clock();
      const attempt = byAttemptId(attemptId);
      const decision = authorizeExtension({ window, config, attempt, grantedBy, grantedByRole, reason, nowMs });
      if (!decision.granted) return { ok: false, reason: decision.reason };

      attempts[attempts.indexOf(attempt)] = applyExtension(attempt, decision.record);
      extensionLog.push(decision.record);
      return { ok: true, deadlineMs: decision.deadlineAfterMs, effectiveMinutes: decision.effectiveMinutes, record: decision.record };
    }
  };
}
