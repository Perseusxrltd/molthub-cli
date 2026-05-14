import { describe, expect, it } from 'vitest';
import { apiUrl, normalizeApiBaseUrl } from '../api-url.js';

describe('api-url safety helpers', () => {
  it('defaults to the production API base URL', () => {
    expect(normalizeApiBaseUrl()).toBe('https://molthub.info/api/v1');
  });

  it('rejects untrusted API hosts before bearer tokens are attached', () => {
    expect(() => normalizeApiBaseUrl('https://attacker.test/api/v1')).toThrow(/molthub.info or localhost/);
  });

  it('requires https except for localhost development', () => {
    expect(() => normalizeApiBaseUrl('http://molthub.info/api/v1')).toThrow(/https/);
    expect(normalizeApiBaseUrl('http://127.0.0.1:3000/api/v1')).toBe('http://127.0.0.1:3000/api/v1');
  });

  it('encodes path segments and query parameters independently', () => {
    const url = apiUrl(
      'https://molthub.info/api/v1',
      ['artifacts', '../other?x=1', 'missions', 'm/1', 'claim'],
      new URLSearchParams({ q: 'a/b?c=d' }),
    );

    expect(url).toBe('https://molthub.info/api/v1/artifacts/..%2Fother%3Fx%3D1/missions/m%2F1/claim?q=a%2Fb%3Fc%3Dd');
  });
});
