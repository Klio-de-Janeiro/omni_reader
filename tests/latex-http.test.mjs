import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { handleLatexRequest } from '../scripts/latex-http.mjs';

test('Local HTTP compilation requires same origin, explicit trust and a custom JSON request', async t => {
  const calls = [];
  const service = { async status() { return { available: true }; }, async compile(input) { calls.push(input); return { ok: true, pdf: Buffer.from('%PDF-test'), diagnostics: [], log: '' }; } };
  const server = createServer((req,res) => void handleLatexRequest(req,res,service));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}/api/latex`;
  assert.equal((await (await fetch(base + '/status')).json()).available, true);
  const send = (input, extra = {}) => fetch(base + '/compile', { method: 'POST', headers: { 'Content-Type':'application/json','X-Omni-Latex':'1',...extra },body:JSON.stringify(input) });
  const input = { name:'main.tex', source:'text', trusted:true, files:[{path:'chapter.tex',bytes:Buffer.from('chapter').toString('base64')}] };
  assert.equal((await send(input, { Origin:'https://evil.example' })).status, 403);
  const foreignHost = await new Promise((resolve,reject) => {
    const req = request(base + '/compile', { method:'POST',headers:{ Host:'evil.example','Content-Type':'application/json','X-Omni-Latex':'1' } }, res => { res.resume(); res.on('end',() => resolve(res.statusCode)); });
    req.on('error',reject); req.end(JSON.stringify(input));
  });
  assert.equal(foreignHost, 403);
  assert.equal((await send(input, { 'X-Omni-Latex':'' })).status, 403);
  assert.equal((await send({...input,trusted:false})).status, 403);
  assert.equal(calls.length, 0);
  const response = await send(input);
  assert.equal(response.status, 200);
  assert.equal(Buffer.from((await response.json()).pdf,'base64').toString(), '%PDF-test');
  assert.equal(calls[0].files[0].bytes.toString(), 'chapter');
});
