import { VERSION } from '../version.js';
import type { CliIo } from './io.js';
import { SQL_USAGE, runSql } from './sql.js';

export type { CliIo } from './io.js';

const HELP = `dynalitics ${VERSION}

Commands
  sql       Prints the recommended table, indexes and least-privilege GRANTs.
            It only prints (or writes a file): it never connects to a database and never executes anything.
  inspect   (planned) Read-only look at a table you already have.

Usage
  ${SQL_USAGE.split('\n').join('\n  ')}
  dynalitics --help | --version
`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      io.stderr(HELP);
      return 1;
    case '--help':
    case '-h':
    case 'help':
      io.stdout(HELP);
      return 0;
    case '--version':
    case '-v':
      io.stdout(`${VERSION}\n`);
      return 0;
    case 'sql':
      return Promise.resolve(runSql(rest, io));
    case 'inspect':
      io.stderr('dynalitics inspect is not available yet (planned for phase 2).\n');
      return 1;
    default:
      io.stderr(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`);
      return 1;
  }
}
