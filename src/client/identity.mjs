/**
 * Canonical student identity entry: `Full Name — Grade`, plus a personal email.
 *
 * This module validates SHAPE ONLY. It never holds a roster, and it never decides who
 * someone is — the server resolves the canonical form against the protected roster.
 * Keeping identity resolution off the client is what lets the client stay public.
 */

const SEPARATORS = /\s*[—–-]\s*/; // em dash is canonical; en dash and hyphen are accepted input
export const CANONICAL_SEPARATOR = ' — ';
export const MIN_GRADE = 6;
export const MAX_GRADE = 12;

export const IDENTITY_PROBLEM = {
  MISSING: 'missing',
  NO_SEPARATOR: 'no-separator',
  MISSING_NAME: 'missing-name',
  MISSING_GRADE: 'missing-grade',
  GRADE_NOT_A_NUMBER: 'grade-not-a-number',
  GRADE_OUT_OF_RANGE: 'grade-out-of-range'
};

/**
 * Parse `"Ada Lovelace — 11"` into its parts and a canonical form.
 * Lenient about which dash and how much whitespace the student typed; strict about
 * everything else, because the canonical form is what the server matches on.
 */
export function parseIdentity(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { valid: false, problem: IDENTITY_PROBLEM.MISSING };
  }
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const parts = text.split(SEPARATORS);
  if (parts.length < 2) return { valid: false, problem: IDENTITY_PROBLEM.NO_SEPARATOR };

  const gradeText = parts[parts.length - 1].trim();
  const name = parts.slice(0, -1).join(CANONICAL_SEPARATOR).trim();

  if (name === '') return { valid: false, problem: IDENTITY_PROBLEM.MISSING_NAME };
  if (gradeText === '') return { valid: false, problem: IDENTITY_PROBLEM.MISSING_GRADE };
  if (!/^\d{1,2}$/.test(gradeText)) return { valid: false, problem: IDENTITY_PROBLEM.GRADE_NOT_A_NUMBER };

  const grade = Number(gradeText);
  if (grade < MIN_GRADE || grade > MAX_GRADE) {
    return { valid: false, problem: IDENTITY_PROBLEM.GRADE_OUT_OF_RANGE, grade };
  }

  return { valid: true, name, grade, canonical: `${name}${CANONICAL_SEPARATOR}${grade}` };
}

// Intentionally permissive: an email mismatch is flagged for owner review, never used
// as identity proof, so rejecting unusual-but-valid addresses would only lock out a
// student who typed their own address correctly.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { valid: false, problem: 'missing' };
  const email = raw.normalize('NFKC').trim();
  if (!EMAIL_SHAPE.test(email)) return { valid: false, problem: 'malformed' };
  return { valid: true, email: email.toLowerCase() };
}

export const NAME_MAX_LENGTH = 60;

export const FIELD_PROBLEM = { MISSING: 'missing', TOO_LONG: 'too-long', OUT_OF_RANGE: 'out-of-range' };

/**
 * Validate first name, last name, and grade entered in separate fields.
 *
 * Replaces the single `Full Name — Grade` text box: three fields need no dash format to
 * remember, and the server matches each part forgivingly (see policy/roster-match.mjs).
 * Shape only — who the student is gets decided on the server.
 */
export function validateIdentityFields({ firstName, lastName, grade }) {
  const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const first = clean(firstName);
  const last = clean(lastName);
  const problems = {};

  if (first === '') problems.firstName = FIELD_PROBLEM.MISSING;
  else if (first.length > NAME_MAX_LENGTH) problems.firstName = FIELD_PROBLEM.TOO_LONG;
  if (last === '') problems.lastName = FIELD_PROBLEM.MISSING;
  else if (last.length > NAME_MAX_LENGTH) problems.lastName = FIELD_PROBLEM.TOO_LONG;

  const gradeText = clean(grade);
  const gradeNumber = Number(gradeText);
  if (gradeText === '') problems.grade = FIELD_PROBLEM.MISSING;
  else if (!/^\d{1,2}$/.test(gradeText) || gradeNumber < MIN_GRADE || gradeNumber > MAX_GRADE) problems.grade = FIELD_PROBLEM.OUT_OF_RANGE;

  if (Object.keys(problems).length > 0) return { valid: false, problems };
  return {
    valid: true,
    firstName: first,
    lastName: last,
    grade: gradeNumber,
    canonical: `${first} ${last}${CANONICAL_SEPARATOR}${gradeNumber}`,
    display: `${first} ${last}, grade ${gradeNumber}`
  };
}
