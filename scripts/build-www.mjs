// Monta www/ (o que vai dentro do APK): só o app do promotor e o que ele importa.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), readFileSync(join(root, 'campo.html'), 'utf8'));
for (const file of ['styles.css', 'field.css']) cpSync(join(root, file), join(out, file));
cpSync(join(root, 'src'), join(out, 'src'), { recursive: true, filter: (p) => !p.endsWith('app.js') && !p.endsWith('csv.js') });
console.log('www/ pronto');
