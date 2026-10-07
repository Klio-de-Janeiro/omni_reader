import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import pngjs from '../vendor-sources/pngjs/lib/png.js';

/** Resize with premultiplied alpha, keeping a non-square logo's proportions. */
export function resizedLogo(image, size, padding = 0) {
  const result = new pngjs.PNG({ width: size, height: size });
  const extent = size * (1 - 2 * padding), scale = Math.min(extent / image.width, extent / image.height);
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const left = Math.floor((size - width) / 2), top = Math.floor((size - height) / 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, Math.min(image.width - 1, (x + .5) * image.width / width - .5));
    const sy = Math.max(0, Math.min(image.height - 1, (y + .5) * image.height / height - .5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, image.width - 1), y1 = Math.min(y0 + 1, image.height - 1);
    const fx = sx - x0, fy = sy - y0, samples = [[x0,y0,(1-fx)*(1-fy)],[x1,y0,fx*(1-fy)],[x0,y1,(1-fx)*fy],[x1,y1,fx*fy]];
    const offset = ((top + y) * size + left + x) * 4, premultiplied = [0, 0, 0]; let alpha = 0;
    for (const [ix, iy, weight] of samples) {
      const input = (iy * image.width + ix) * 4, a = image.data[input + 3] * weight; alpha += a;
      for (let channel = 0; channel < 3; channel++) premultiplied[channel] += image.data[input + channel] * a;
    }
    for (let channel = 0; channel < 3; channel++) result.data[offset + channel] = alpha ? Math.round(premultiplied[channel] / alpha) : 0;
    result.data[offset + 3] = Math.round(alpha);
  }
  return pngjs.PNG.sync.write(result);
}

/** PNG-backed ICO entries are supported by the Windows versions used by Electron. */
export function windowsIcon(images) {
  const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  for (const [index, { size, bytes }] of images.entries()) {
    const entry = 6 + index * 16; header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += bytes.length;
  }
  return Buffer.concat([header, ...images.map(image => image.bytes)]);
}

/** An optional omni.png next to BUILD_*.cmd replaces web, desktop and Android logos. */
export async function syncBranding(root = process.cwd()) {
  const input = path.join(root, 'omni.png');
  let info; try { info = await stat(input); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('omni.png должен быть PNG-файлом размером до 16 МиБ.');
  const bytes = await readFile(input);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('omni.png должен содержать настоящее изображение PNG.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('Размер omni.png: от 1 до 4096 пикселей по каждой стороне.');
  const image = pngjs.PNG.sync.read(bytes), dist = path.join(root, 'dist');
  const icon192 = resizedLogo(image, 192), icon512 = resizedLogo(image, 512);
  await writeFile(path.join(dist, 'omni.png'), bytes);
  await writeFile(path.join(dist, 'icon-192.png'), icon192);
  await writeFile(path.join(dist, 'icon-512.png'), icon512);
  await writeFile(path.join(dist, 'icon-maskable.png'), resizedLogo(image, 512, .12));
  await writeFile(path.join(dist, 'icon.ico'), windowsIcon([16,24,32,48,64,128,256].map(size => ({ size, bytes: resizedLogo(image, size) }))));
  const indexPath = path.join(dist, 'index.html'), html = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, html.replace(/<img\b[^>]*id="brand-logo"[^>]*>/, '<img id="brand-logo" src="./omni.png" alt="" width="38" height="38">')
    .replace(/<link\b[^>]*id="app-favicon"[^>]*>/, '<link id="app-favicon" rel="icon" href="./omni.png" type="image/png">'));
  const manifestPath = path.join(dist, 'manifest.webmanifest'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.icons = [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const drawable = path.join(root, 'android/app/src/main/res/drawable'); await mkdir(drawable, { recursive: true });
  await writeFile(path.join(drawable, 'omni_launcher.png'), icon512);
  const androidManifest = path.join(root, 'android/app/src/main/AndroidManifest.xml');
  const xml = await readFile(androidManifest, 'utf8');
  await writeFile(androidManifest, xml.replace(/android:icon="[^"]+"/, 'android:icon="@drawable/omni_launcher"'));
  console.log('Custom omni.png logo synchronized for web, Windows and Android.'); return true;
}
