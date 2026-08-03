/**
 * Sweeps the entire working tree for personal email addresses and fails the build
 * if it finds one.
 *
 * This exists because the row-level gate in src/pii.ts only sees what the recorder
 * writes — and during M1 the leak was somewhere else entirely: verbatim packuments
 * in the archive, and 229 real maintainer addresses across 10,225 occurrences in
 * committed test fixtures. A gate that guards one path is not a policy.
 *
 * Runs in CI on every push and pull request, needs no secrets, and is the last
 * thing standing between a mistake and a public repository.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exit } from 'node:process';

import { EMAIL_RE, isNonPersonalAddress } from '../src/pii.ts';

/** A literal NUL cannot live in source without git treating the file as binary. */
const NUL_BYTE = String.fromCharCode(0);

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.zip', '.gz']);

/**
 * The only addresses allowed anywhere in this repository are ones RFC 2606
 * reserves so they can be written down without belonging to anybody:
 * example.com/.net/.org, and the .invalid TLD where fixture pseudonyms live.
 *
 * There is deliberately no allowlist of "obviously fake" placeholders like
 * `alice@example.com`. An allowlist of judgement calls is exactly the thing that erodes
 * one exception at a time until it protects nothing.
 */
const DOC_DOMAINS = /@(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|redacted\.invalid|invalid|test|localhost)$/i;

/**
 * Scope is what git tracks or would track — never ignored files. `.env.local`
 * legitimately holds a real address; the question this answers is what could
 * reach the repository, not what exists on the developer's disk.
 */
function repoFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter((f) => f.length > 0);
}

const offenders: string[] = [];
const skippedAsBinary: string[] = [];
let filesScanned = 0;

for (const file of repoFiles()) {
  if (SKIP_EXT.has(file.slice(file.lastIndexOf('.')))) continue;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable or binary
  }
  if (text.includes(NUL_BYTE)) {
    // A source file containing a raw NUL is almost certainly a mistake, and the
    // consequence is severe: src/pii.ts once held one, so the audit silently
    // skipped the very file defining the policy it enforces. Never skip quietly.
    skippedAsBinary.push(file);
    continue;
  }
  filesScanned++;

  // Remove fixture pseudonyms individually first: two adjacent ones sit flush
  // against each other (a real maintainer field holds two addresses with no
  // separator) and would otherwise scan as a single malformed token.
  const cleaned = text.replace(/maintainer[N\d]+@redacted\.invalid/g, ' ');

  for (const match of cleaned.match(new RegExp(EMAIL_RE.source, 'g')) ?? []) {
    if (isNonPersonalAddress(match)) continue;
    if (DOC_DOMAINS.test(match)) continue;
    offenders.push(`${file}: ${match}`);
  }
}

// A text file that scans as binary is a hole in the audit, so it fails the build
// rather than appearing as a warning nobody reads.
const TEXT_EXT = /\.(ts|js|json|md|yml|yaml|txt|npmrc|gitignore|gitattributes|nvmrc|example)$/i;
const unexpectedlyBinary = skippedAsBinary.filter((f) => TEXT_EXT.test(f) || !f.includes('.'));
if (unexpectedlyBinary.length > 0) {
  console.error('\nPII audit FAILED — text files skipped as binary, so they went unchecked:\n');
  for (const f of unexpectedlyBinary) console.error(`  ${f}`);
  console.error(
    '\nThese contain a raw NUL byte. Replace it with an escape sequence so the file ' +
      'is text — otherwise it is invisible to this audit and to git diffs.\n',
  );
  exit(1);
}

if (offenders.length > 0) {
  console.error(`\nPII audit FAILED — ${offenders.length} personal address(es) in the tree:\n`);
  for (const o of [...new Set(offenders)].slice(0, 40)) console.error(`  ${o}`);
  console.error(
    '\nThis repository must not carry maintainer contact details. Redact with ' +
      'redactEmailsDeep() from src/redact.ts, or use an example.com address if it is ' +
      'documentation.\n',
  );
  exit(1);
}

console.log(
  `PII audit passed: ${filesScanned} files scanned, no personal addresses.` +
    (skippedAsBinary.length > 0 ? ` (${skippedAsBinary.length} binary files skipped)` : ''),
);
