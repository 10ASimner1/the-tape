/**
 * Local filesystem store. Used for M1 development and by every test, so the
 * whole recorder can run end to end before any cloud provider is chosen.
 */

import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';

import type { Store, StoreObject } from './store.ts';

export class FsStore implements Store {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  #path(key: string): string {
    // Keys are always POSIX-style; package names are already percent-encoded by
    // the key builders, so no separator can appear inside a single segment.
    return join(this.#root, ...key.split('/'));
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.#path(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    // Write to a temp name then rename, so a killed process never leaves a
    // half-written object that later reads as valid.
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  }

  async putIfAbsent(key: string, body: Uint8Array): Promise<{ written: boolean }> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    try {
      // 'wx' fails if the file exists — the filesystem's own compare-and-swap.
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      return { written: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { written: false };
      throw err;
    }
  }

  async list(prefix: string): Promise<StoreObject[]> {
    // A prefix may end mid-segment, so walk from the last complete directory.
    const lastSlash = prefix.lastIndexOf('/');
    const dirKey = lastSlash === -1 ? '' : prefix.slice(0, lastSlash);
    const dir = this.#path(dirKey);

    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const out: StoreObject[] = [];
    for (const entry of entries) {
      const abs = join(dir, entry);
      const key = posix.join(dirKey, relative(dir, abs).split(sep).join('/'));
      if (!key.startsWith(prefix)) continue;
      if (key.endsWith('.tmp')) continue;
      const s = await stat(abs);
      if (s.isFile()) out.push({ key, size: s.size });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }
}
