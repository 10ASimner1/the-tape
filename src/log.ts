/**
 * NDJSON to stdout. Workflow logs are public, so this never prints record
 * contents, headers, environment or credentials — only counts, seq ranges,
 * package names and status codes.
 */

type Fields = Record<string, string | number | boolean | null | undefined>;

function emit(level: string, msg: string, fields?: Fields): void {
  const row: Record<string, unknown> = { t: new Date().toISOString(), level, msg };
  if (fields) for (const [k, v] of Object.entries(fields)) if (v !== undefined) row[k] = v;
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

/** Human-readable run summary for $GITHUB_STEP_SUMMARY. Same redaction rules apply. */
export async function writeStepSummary(lines: string[]): Promise<void> {
  const path = process.env['GITHUB_STEP_SUMMARY'];
  if (!path) return;
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${lines.join('\n')}\n`, 'utf8');
}
