import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PackumentDoc } from '../src/packument.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Fixtures are verbatim captures from the live registry (2026-08-02), stored raw
 * rather than reduced so a reader can verify any claim in the tests against the
 * actual bytes npm served. They are immutable evidence, not editable test data.
 */
export function packument(fixtureName: string): PackumentDoc {
  const path = join(here, 'fixtures', 'packuments', `${fixtureName}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as PackumentDoc;
}

/** Fixture files use `_` for the `@` and `/` of a scoped name. */
export const SCOPED_TINYCOLOR = '_ctrl_tinycolor';
export const SCOPED_OPENPOND = '_openpond_sdk';
