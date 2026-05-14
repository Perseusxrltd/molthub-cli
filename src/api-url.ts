export const DEFAULT_API_BASE_URL = 'https://molthub.info/api/v1';

const TRUSTED_API_HOSTS = new Set([
  'molthub.info',
  'www.molthub.info',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class UntrustedApiBaseUrlError extends Error {
  code = 'ERR_UNTRUSTED_BASE_URL';

  constructor(message: string) {
    super(message);
    this.name = 'UntrustedApiBaseUrlError';
  }
}

export function normalizeApiBaseUrl(input?: string) {
  const raw = input?.trim() || DEFAULT_API_BASE_URL;
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    throw new UntrustedApiBaseUrlError('MOLTHUB_BASE_URL must be an absolute URL.');
  }

  const host = parsed.hostname === '::1' ? '[::1]' : parsed.hostname.toLowerCase();
  if (!TRUSTED_API_HOSTS.has(host)) {
    throw new UntrustedApiBaseUrlError('MOLTHUB_BASE_URL must point to molthub.info or localhost.');
  }

  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOCALHOST_HOSTS.has(host))) {
    throw new UntrustedApiBaseUrlError('MOLTHUB_BASE_URL must use https unless it targets localhost.');
  }

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  return parsed.toString().replace(/\/$/, '');
}

export function apiPathSegment(value: string | number | boolean) {
  return encodeURIComponent(String(value));
}

export function apiUrl(baseUrl: string, segments: Array<string | number | boolean>, params?: URLSearchParams) {
  const path = segments.map(apiPathSegment).join('/');
  const query = params?.toString();
  return `${baseUrl}/${path}${query ? `?${query}` : ''}`;
}
