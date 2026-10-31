import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): string;
  exists(path: string): boolean;
  writeFile(path: string, content: string, overwrite: boolean): void;
}

export const nodeIo: CliIo = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readFile: (path) => readFileSync(path, 'utf8'),
  exists: (path) => existsSync(path),
  // 'wx' fails if the file appeared since the exists() check, so a race cannot overwrite it.
  writeFile: (path, content, overwrite) =>
    writeFileSync(path, content, { flag: overwrite ? 'w' : 'wx' }),
};
