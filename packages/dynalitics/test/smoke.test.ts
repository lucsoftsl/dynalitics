import { expect, test } from 'vitest';
import { DynaliticsConfigError, createDynalitics } from '../src/index.js';

test('the public entry point exposes createDynalitics, which validates its config before touching anything', async () => {
  expect(typeof createDynalitics).toBe('function');
  await expect(createDynalitics({} as never)).rejects.toBeInstanceOf(DynaliticsConfigError);
});
