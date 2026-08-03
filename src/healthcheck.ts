/**
 * External dead-man's switch.
 *
 * This is the only thing that can tell you the recorder stopped. GitHub disables
 * scheduled workflows after 60 days of repository inactivity with no email, no log
 * entry and no notification of any kind — a failure the system cannot detect from
 * inside itself, because the thing that would report it is the thing that stopped.
 *
 * Deliberately best-effort: a monitoring outage must never fail a recording run.
 * The tape wins over its own telemetry.
 */

import { log } from './log.ts';

const PING_TIMEOUT_MS = 8_000;

async function ping(base: string, suffix: string): Promise<void> {
  try {
    await fetch(`${base.replace(/\/+$/, '')}${suffix}`, {
      method: 'POST',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch (err) {
    // Never rethrow, and never log the URL — a healthchecks ping URL is a
    // capability, and workflow logs on a public repo are world-readable.
    log.warn('healthcheck ping failed', { kind: (err as Error).name, suffix: suffix || 'success' });
  }
}

export class Healthcheck {
  readonly #url: string | undefined;

  constructor(url: string | undefined) {
    this.#url = url !== undefined && url.length > 0 ? url : undefined;
    if (this.#url === undefined) {
      log.warn('no healthcheck configured — a silent stop would go unnoticed');
    }
  }

  /** Marks the run as started, so a hung run is distinguishable from a dropped one. */
  async start(): Promise<void> {
    if (this.#url) await ping(this.#url, '/start');
  }

  async success(): Promise<void> {
    if (this.#url) await ping(this.#url, '');
  }

  async fail(): Promise<void> {
    if (this.#url) await ping(this.#url, '/fail');
  }
}
