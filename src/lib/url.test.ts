import { describe, it, expect } from 'vitest';
import { sanitizeUrl } from './url';

describe('sanitizeUrl', () => {
  it('passes plain http/https URLs through unchanged (trimmed)', () => {
    expect(sanitizeUrl('https://example.com/docs')).toBe('https://example.com/docs');
    expect(sanitizeUrl('  http://example.com  ')).toBe('http://example.com');
  });

  it('rejects javascript: URLs including casing/whitespace tricks', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl(' JaVaScRiPt:alert(1)')).toBeNull();
  });

  it('rejects data:, vbscript:, and about: schemes', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeUrl('about:blank')).toBeNull();
  });

  it('rejects protocol-relative and bare-path strings', () => {
    expect(sanitizeUrl('//evil.com/x')).toBeNull();
    expect(sanitizeUrl('/relative/path')).toBeNull();
    expect(sanitizeUrl('example.com')).toBeNull();
  });

  it('rejects empty/garbage input', () => {
    expect(sanitizeUrl('')).toBeNull();
    expect(sanitizeUrl('not a url')).toBeNull();
  });
});
