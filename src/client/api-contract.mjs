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
  'file', 'source_pdf', 'source_page', 'crop'
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
 * In-memory stand-in for the eventual Apps Script endpoint.
 *
 * Holds the protected side (tests with keys, access codes, attempt records) and never
 * returns any of it. `clock` is injected so tests control time exactly.
 */
export function createMockEndpoint({ config, tests, accessCodes, clock, imageStore = {}, failFor = () => null }) {
  const window = resolveSessionWindow(config);
  const attempts = [];
  const submissions = [];
  const extensionLog = [];

  const findAttempt = (identityKey, testId) =>
    attempts.find((attempt) => attempt.identityKey === identityKey && attempt.testId === testId);

  return {
    window,
    /** Test-only inspection of protected state; never exposed over the wire. */
    _state: () => ({ attempts, submissions, extensionLog }),

    async startAttempt({ identityKey, testId, blockId, accessCode }) {
      const forced = failFor('startAttempt');
      if (forced) throw forced;

      const nowMs = clock();
      const result = authorizeStart({
        window,
        config,
        request: { identityKey, testId, blockId, accessCodeValid: accessCodes[testId] === accessCode },
        priorAttempts: attempts,
        nowMs
      });

      if (result.decision === START_DECISIONS.REFUSED) {
        return { ok: false, decision: result.decision, reason: result.reason, serverNowMs: nowMs };
      }
      if (result.decision === START_DECISIONS.AUTHORIZED) attempts.push(result.attempt);

      const artifact = toStudentArtifact(tests[testId]);
      assertNoProtectedFields(artifact); // belt and braces: fail loudly rather than leak
      return {
        ok: true,
        decision: result.decision,
        testId,
        artifact,
        serverNowMs: nowMs,
        deadlineMs: result.deadlineMs,
        firstDeliveryMs: result.firstDeliveryMs
      };
    },

    async submitAttempt(submission) {
      const forced = failFor('submitAttempt');
      if (forced) throw forced;

      const nowMs = clock();
      const attempt = findAttempt(submission.identityKey, submission.testId);
      const receipt = authorizeSubmission({
        window, config, attempt, submission,
        priorSubmissions: submissions.filter((s) => s.identityKey === submission.identityKey),
        nowMs
      });
      // Away time recomputed from the raw events on the server side, not taken from the
      // client's own summary. Events carry device-clock times, so convert the attempt window.
      const offsetMs = (submission.clientServerNowMs ?? nowMs) - (submission.clientSubmittedAtMs ?? nowMs);
      const away = attempt
        ? computeAwayTime(submission.activity ?? [], {
          startMs: attempt.firstDeliveryMs - offsetMs,
          endMs: Math.min(submission.clientSubmittedAtMs ?? nowMs - offsetMs, (receipt.deadlineMs ?? Infinity) - offsetMs)
        })
        : null;
      const stored = { ...receipt, identityKey: submission.identityKey, answers: submission.answers, activity: submission.activity, away };
      if (receipt.outcome !== SUBMISSION_OUTCOMES.REPLAY) submissions.push(stored);
      // A receipt carries status only — never a score, never correctness.
      return { ok: true, outcome: receipt.outcome, late: receipt.late, receiptMs: receipt.receiptMs, submissionId: receipt.submissionId };
    },

    /** Image bytes for a started attempt on this test only; see image-policy.mjs. */
    async getImages({ identityKey, testId, imageIds }) {
      const forced = failFor('getImages');
      if (forced) throw forced;
      const nowMs = clock();
      const decision = authorizeImageFetch({
        window, config, attempt: findAttempt(identityKey, testId), test: tests[testId], imageIds, nowMs
      });
      if (!decision.authorized) return { ok: false, reason: decision.reason };
      return {
        ok: true,
        images: imageIds.map((id) => {
          const stored = imageStore[testId]?.[id];
          return stored ? { id, mimeType: stored.mimeType, dataBase64: bytesToBase64(stored.bytes) } : { id, missing: true };
        })
      };
    },

    async grantExtension({ identityKey, testId, grantedBy, grantedByRole, reason }) {
      const nowMs = clock();
      const attempt = findAttempt(identityKey, testId);
      const decision = authorizeExtension({ window, config, attempt, grantedBy, grantedByRole, reason, nowMs });
      if (!decision.granted) return { ok: false, reason: decision.reason };

      const index = attempts.indexOf(attempt);
      attempts[index] = applyExtension(attempt, decision.record);
      extensionLog.push(decision.record);
      return {
        ok: true,
        deadlineMs: decision.deadlineAfterMs,
        effectiveMinutes: decision.effectiveMinutes,
        record: decision.record
      };
    }
  };
}
