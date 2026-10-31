import { expect, test } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

test('package entry point loads', () => {
  expect(PACKAGE_NAME).toBe('dynalitics-dashboard');
});
