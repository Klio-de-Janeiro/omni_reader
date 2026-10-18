import { LatexService } from '../desktop/latex.cjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
export const createLatexService = () => new LatexService({ runtimeDir: path.join(project, 'desktop', 'latex-runtime'), cacheDir: path.join(project, '.tools', 'latex-cache') });

/** The local compiler is never exposed to other sites, arbitrary hosts or remote clients. */
export async function handleLatexRequest(req, res, service) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/latex/')) return false;
  const reply = (status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const host = req.headers.host || '', remote = req.socket.remoteAddress;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  if (!local || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host) || req.headers.origin && req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') {
    reply(403, { message: 'Компиляция разрешена только из локального окна Omni.' }); return true;
  }
  if (url.pathname === '/api/latex/status' && req.method === 'GET') {
    try { reply(200, { ...await service.status(), busy: !!service.job }); } catch (error) { reply(503, { available: false, message: error.message }); }
    return true;
  }
  if (url.pathname !== '/api/latex/compile' || req.method !== 'POST') { reply(404, { message: 'Not found' }); return true; }
  if (req.headers['x-omni-latex'] !== '1' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { reply(403, { message: 'Недопустимый запрос компиляции.' }); return true; }
  const abort = new AbortController();
  const disconnected = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', disconnected);
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 96 * 1024 * 1024) { reply(413, { message: 'Проект слишком большой.' }); return true; }
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.trusted !== true) { reply(403, { message: 'Сначала подтвердите доверие к TeX-проекту.' }); return true; }
    if (input.files !== undefined && (!Array.isArray(input.files) || input.files.length > 256)) throw new Error('Не больше 256 файлов проекта.');
    let assetSize = 0;
    const files = (input.files || []).map(file => {
      if (typeof file.bytes !== 'string' || file.bytes.length > 90 * 1024 * 1024 || file.bytes.length % 4 || /[^A-Za-z0-9+/=]/.test(file.bytes) || /=/.test(file.bytes.slice(0,-2))) throw new Error('Неверные данные файла проекта.');
      const bytes = Buffer.from(file.bytes, 'base64'); assetSize += bytes.length;
      if (assetSize > 64 * 1024 * 1024) throw new Error('Файлы проекта превышают лимит 64 МиБ.');
      return { path: file.path, bytes };
    });
    const result = await service.compile({ id: input.id, name: input.name, source: input.source, files }, { signal: abort.signal });
    reply(200, { ...result, pdf: result.pdf ? Buffer.from(result.pdf).toString('base64') : null });
  } catch (error) {
    if (!abort.signal.aborted) reply(/уже|busy/i.test(error.message) ? 409 : 400, { message: error.message });
  } finally { res.off('close', disconnected); }
  return true;
}
