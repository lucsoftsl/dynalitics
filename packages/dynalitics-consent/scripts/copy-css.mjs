// Copies the banner stylesheet next to the compiled JavaScript (dynalitics-consent/styles.css). Build time only.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });
copyFileSync(join(root, 'src/styles.css'), join(root, 'dist/styles.css'));
