import { cp, mkdir, readFile } from 'node:fs/promises';
import { syncBranding } from './branding.mjs';
await syncBranding();
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const target of ['android/app/src/main/assets/www', 'desktop/www']) {
  await mkdir(target, { recursive: true });
  await cp('dist', target, { recursive: true });
}
console.log(`Native assets synchronized for Omni ${manifest.version}.`);
