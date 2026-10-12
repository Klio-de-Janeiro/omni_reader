import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { syncBranding } from './branding.mjs';
await syncBranding();
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const target of ['android/app/src/main/assets/www', 'desktop/www']) {
  await mkdir(target, { recursive: true });
  for (const name of await readdir(target)) {
    if (/^recorder(?:-|\.)/.test(name)) await rm(`${target}/${name}`, { force: true });
  }
  await cp('dist', target, { recursive: true, filter: source => !/^recorder(?:-|\.)/.test(source.split(/[\\/]/).at(-1)) });
}
console.log(`Native assets synchronized for Omni ${manifest.version}.`);
