import { describe, expect, it } from 'vitest';
import { hasAllowedBrowserOrigin, isAllowedHost } from '../../../src/server/middleware/admin-origin.js';

describe('admin-origin helpers', () => {
  const allowed = new Set(['localhost', '127.0.0.1', 'localhost:8080', '127.0.0.1:8080']);

  it('allows loopback hosts with explicit or injected ports', () => {
    expect(isAllowedHost('localhost', allowed)).toBe(true);
    expect(isAllowedHost('localhost:80', allowed)).toBe(true);
    expect(isAllowedHost('127.0.0.1:8080', allowed)).toBe(true);
    expect(isAllowedHost('evil.example:8080', allowed)).toBe(false);
  });

  it('allows absent browser origin for non-browser clients and rejects cross-origin browsers', () => {
    expect(hasAllowedBrowserOrigin({ headers: {} } as never, allowed)).toBe(true);
    expect(hasAllowedBrowserOrigin({ headers: { origin: 'http://localhost:8080' } } as never, allowed)).toBe(true);
    expect(hasAllowedBrowserOrigin({ headers: { origin: 'http://evil.example' } } as never, allowed)).toBe(false);
  });
});
