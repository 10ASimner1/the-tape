/**
 * Store test doubles.
 *
 * NOT a *.test.ts file: `node --test test/*.test.ts` would execute it.
 *
 * Every one of these is a hand-written delegating class rather than a Proxy.
 * FsStore holds private class fields, so calling a method with a proxy as the
 * receiver throws "Receiver must be an instance of".
 */

import { identityOf, type Store, type StoreIdentity, type StoreObject } from '../src/store.ts';

export class FailingPutStore implements Store {
  readonly #inner: Store;
  readonly #fails: (key: string) => boolean;

  constructor(inner: Store, fails: (key: string) => boolean) {
    this.#inner = inner;
    this.#fails = fails;
  }

  get identity(): StoreIdentity | null { return identityOf(this.#inner); }
  get(key: string) { return this.#inner.get(key); }
  list(prefix: string) { return this.#inner.list(prefix); }
  delete(key: string) { return this.#inner.delete(key); }

  async put(key: string, body: Uint8Array): Promise<void> {
    if (this.#fails(key)) throw new Error(`object store unavailable: ${key}`);
    return this.#inner.put(key, body);
  }

  async putIfAbsent(key: string, body: Uint8Array): Promise<{ written: boolean }> {
    if (this.#fails(key)) throw new Error(`object store unavailable: ${key}`);
    return this.#inner.putIfAbsent(key, body);
  }
}

/** Returns null for selected keys, so "the primary listed it and then could not
 *  produce it" is reachable in a test. */
export class VanishingGetStore implements Store {
  readonly #inner: Store;
  readonly #vanishes: (key: string) => boolean;

  constructor(inner: Store, vanishes: (key: string) => boolean) {
    this.#inner = inner;
    this.#vanishes = vanishes;
  }

  get identity(): StoreIdentity | null { return identityOf(this.#inner); }
  put(key: string, body: Uint8Array) { return this.#inner.put(key, body); }
  putIfAbsent(key: string, body: Uint8Array) { return this.#inner.putIfAbsent(key, body); }
  list(prefix: string) { return this.#inner.list(prefix); }
  delete(key: string) { return this.#inner.delete(key); }

  async get(key: string): Promise<Uint8Array | null> {
    if (this.#vanishes(key)) return null;
    return this.#inner.get(key);
  }
}

/** Counts operations, so "the second run copied nothing" can be asserted as a
 *  fact about requests rather than inferred from the result. */
export class CountingStore implements Store {
  readonly #inner: Store;
  puts = 0;
  putIfAbsents = 0;
  gets = 0;
  lists = 0;

  constructor(inner: Store) {
    this.#inner = inner;
  }

  get identity(): StoreIdentity | null { return identityOf(this.#inner); }

  async get(key: string): Promise<Uint8Array | null> {
    this.gets++;
    return this.#inner.get(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.puts++;
    return this.#inner.put(key, body);
  }

  async putIfAbsent(key: string, body: Uint8Array): Promise<{ written: boolean }> {
    this.putIfAbsents++;
    return this.#inner.putIfAbsent(key, body);
  }

  async list(prefix: string): Promise<StoreObject[]> {
    this.lists++;
    return this.#inner.list(prefix);
  }

  delete(key: string) { return this.#inner.delete(key); }
}
