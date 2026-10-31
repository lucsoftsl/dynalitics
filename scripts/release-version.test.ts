import { describe, expect, test } from 'vitest';
import { highestRelease, nextVersion, withVersion } from './release-version.mjs';

describe('nextVersion (automatic release on push)', () => {
  test.each([
    ['0.1.0', null, '0.1.0'], // first release: the repository version
    ['0.1.0', '0.1.0', '0.1.1'], // the example from the request
    ['0.1.0', '0.1.7', '0.1.8'], // the repository is not committed back, npm holds the truth
    ['0.2.0', '0.1.7', '0.2.0'], // a deliberate minor bump in the repository wins
    ['1.0.0', '0.9.3', '1.0.0'],
    ['0.1.9', '0.1.10', '0.1.11'], // numeric, not string, comparison
  ])('repo %s, npm %s -> %s', (repo, published, expected) => {
    expect(nextVersion(repo, published)).toBe(expected);
  });

  test('refuses anything that is not a plain X.Y.Z', () => {
    expect(() => nextVersion('0.1', null)).toThrow();
    expect(() => nextVersion('0.1.0', '0.2.0-beta.1')).toThrow();
  });
});

describe('withVersion', () => {
  test('sets the version and an exact dynalitics peer pin, nothing else', () => {
    const text = JSON.stringify({
      name: 'dynalitics-postgres',
      version: '0.1.0',
      dependencies: { pg: '8.23.1' },
      peerDependencies: { dynalitics: '0.1.0' },
    });
    expect(JSON.parse(withVersion(text, '0.1.1'))).toEqual({
      name: 'dynalitics-postgres',
      version: '0.1.1',
      dependencies: { pg: '8.23.1' },
      peerDependencies: { dynalitics: '0.1.1' },
    });
    expect(JSON.parse(withVersion('{"name":"x","version":"0.1.0"}', '0.1.1'))).toEqual({
      name: 'x',
      version: '0.1.1',
    });
  });
});

describe('highestRelease (what npm really has)', () => {
  test('ignores the staged-publishing placeholder and other prereleases', () => {
    expect(highestRelease(['0.0.0-stage'])).toBeNull();
    expect(highestRelease(['0.0.0-stage', '0.1.0'])).toBe('0.1.0');
    expect(highestRelease(['0.1.0', '0.1.10', '0.1.9', '0.2.0-beta.1'])).toBe('0.1.10');
    expect(highestRelease('0.1.0')).toBe('0.1.0'); // npm returns a string when there is one version
    expect(highestRelease(null)).toBeNull();
  });
});
