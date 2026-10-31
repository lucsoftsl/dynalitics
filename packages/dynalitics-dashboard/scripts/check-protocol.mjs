// CI-style guard: the dashboard's vendored wire types must equal the server's protocol.ts.
//   node scripts/check-protocol.mjs          exit 1 if they differ or the server file is missing
//   node scripts/check-protocol.mjs --write  copy the server file over the vendored one
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const VENDORED = join(here, '../src/protocol.ts');
export const SERVER = join(here, '../../dynalitics/src/protocol.ts');

const normalise = (s) => s.replace(/\r\n/g, '\n').trimEnd() + '\n';

/** Returns { ok, reason }. Pure apart from reading the two files. */
export async function compareProtocol(vendoredPath = VENDORED, serverPath = SERVER) {
  let server;
  try {
    server = await readFile(serverPath, 'utf8');
  } catch {
    return { ok: false, reason: `server protocol not found: ${serverPath}` };
  }
  const vendored = await readFile(vendoredPath, 'utf8');
  if (normalise(server) === normalise(vendored)) return { ok: true, reason: 'identical' };
  return {
    ok: false,
    reason:
      'vendored src/protocol.ts differs from the server copy; run with --write after reviewing',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    await writeFile(VENDORED, await readFile(SERVER, 'utf8'));
    console.log('vendored protocol updated from server');
  } else {
    const r = await compareProtocol();
    console.log(r.ok ? 'protocol in sync' : `protocol check failed: ${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }
}
