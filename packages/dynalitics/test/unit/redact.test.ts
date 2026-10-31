import { describe, expect, test } from 'vitest';
import { createRedactor, sanitizeError, secretsFromConnectionString } from '../../src/redact.js';

const CANARY = 'S3cr3t-Canary-Pw';

describe('redaction', () => {
  test('removes the exact connection string and the password inside it', () => {
    const cs = `postgres://app:${CANARY}@db.example.com:5432/analytics`;
    const redact = createRedactor(secretsFromConnectionString(cs));
    const out = redact(`connect failed for ${cs}; password ${CANARY} rejected`);
    expect(out).not.toContain(CANARY);
    expect(out).not.toContain('db.example.com:5432/analytics?');
    expect(out).toContain('[redacted]');
  });

  test('handles url-encoded passwords', () => {
    const cs = 'mysql://app:p%40ss%2Fw0rd%21@host/db';
    const redact = createRedactor(secretsFromConnectionString(cs));
    expect(redact('bad credentials p@ss/w0rd! for app')).not.toContain('p@ss/w0rd!');
    expect(redact('url was p%40ss%2Fw0rd%21')).not.toContain('p%40ss%2Fw0rd%21');
  });

  test('handles ADO style Password= and Pwd= pairs, even when unknown to the redactor', () => {
    const redact = createRedactor([]);
    const out = redact(
      `Server=tcp:x;User Id=sa;Password=${CANARY};Encrypt=true and pwd="${CANARY}2"`,
    );
    expect(out).not.toContain(CANARY);
    expect(out).toContain('Server=tcp:x');
  });

  test('redacts userinfo passwords in URLs never seen before', () => {
    const redact = createRedactor([]);
    expect(redact(`fail postgres://u:${CANARY}@h/db`)).not.toContain(CANARY);
  });

  test('does not mangle text with very short secrets', () => {
    const redact = createRedactor(secretsFromConnectionString('postgres://u:ab@h/db'));
    expect(redact('abstract table')).toBe('abstract table');
  });

  test('sanitizeError keeps name, code and a redacted message, and drops everything else', () => {
    const err = Object.assign(new Error(`login failed with ${CANARY}`), {
      code: 'ECONNREFUSED',
      config: { password: CANARY },
    });
    const safe = sanitizeError(err, createRedactor([CANARY + 'x', CANARY]));
    expect(safe).toEqual({
      name: 'Error',
      code: 'ECONNREFUSED',
      message: 'login failed with [redacted]',
    });
    expect(JSON.stringify(safe)).not.toContain(CANARY);
  });

  test('sanitizeError copes with non-errors', () => {
    expect(sanitizeError('boom', createRedactor([]))).toEqual({ name: 'Error', message: 'boom' });
    expect(sanitizeError(undefined, createRedactor([])).message).toBe('Unknown error');
  });
});
