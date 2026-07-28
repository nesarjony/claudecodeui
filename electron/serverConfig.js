import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_RECENTS = 8;

/**
 * Normalize a user-entered server URL into a canonical origin-rooted URL.
 * Accepts bare hosts ("dev.nesar.dev") and assumes https. Returns null when
 * the value cannot be turned into an http(s) URL.
 */
export function normalizeServerUrl(rawUrl) {
  const trimmed = String(rawUrl == null ? '' : rawUrl).trim();
  if (!trimmed) return null;

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;

  parsed.hash = '';
  parsed.search = '';
  // Keep any pathname the user typed (some servers live under a sub-path),
  // but drop a lone trailing slash so URLs compare/store consistently.
  let normalized = parsed.toString();
  if (normalized.endsWith('/') && parsed.pathname === '/') {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function getOriginForUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function getHostForUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Persists the self-hosted CloudCLI server URL (and recently-used servers)
 * the desktop client connects to. This replaces the bundled local server:
 * the app never spawns a backend, it only remembers where yours lives.
 */
export class ServerConfigController {
  constructor({ storePath, onChange } = {}) {
    this.storePath = storePath;
    this.onChange = onChange;
    this.url = null;
    this.recents = [];
  }

  getUrl() {
    return this.url;
  }

  getRecents() {
    return [...this.recents];
  }

  async load() {
    try {
      const raw = await fs.readFile(this.storePath, 'utf8');
      const stored = JSON.parse(raw);
      this.url = normalizeServerUrl(stored.url) || null;
      this.recents = Array.isArray(stored.recents)
        ? stored.recents.map(normalizeServerUrl).filter(Boolean)
        : [];
      // Ensure the active url is always present in recents.
      if (this.url && !this.recents.includes(this.url)) {
        this.recents.unshift(this.url);
      }
    } catch {
      this.url = null;
      this.recents = [];
    }
    return this.url;
  }

  async save(rawUrl) {
    const url = normalizeServerUrl(rawUrl);
    if (!url) {
      throw new Error('Enter a valid server URL, e.g. https://dev.nesar.dev');
    }
    this.url = url;
    this.recents = [url, ...this.recents.filter((item) => item !== url)].slice(0, MAX_RECENTS);
    await this.#persist();
    this.onChange?.();
    return url;
  }

  async forget(rawUrl) {
    const url = normalizeServerUrl(rawUrl);
    if (!url) return;
    this.recents = this.recents.filter((item) => item !== url);
    if (this.url === url) {
      this.url = null;
    }
    await this.#persist();
    this.onChange?.();
  }

  async clearActive() {
    this.url = null;
    await this.#persist();
    this.onChange?.();
  }

  async #persist() {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(
      this.storePath,
      JSON.stringify({ url: this.url, recents: this.recents }, null, 2),
      'utf8',
    );
  }
}
