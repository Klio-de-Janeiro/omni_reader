const http = require('node:http');
const { SCHEMA, messages } = require('./voice-intents.cjs');
const { timezone } = require('./reminder-time.cjs');
const MAX_RESPONSE = 256 * 1024;
const defaults = () => ({ enabled:false, mode:'commands', backend:'ollama', endpoint:'http://127.0.0.1:11434', model:'', timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow', timeout_seconds:300, cpu_threads:4, temperature:0, require_owner:false });
const cloudModel = name => /(?:^|[-_:/.])(?:cloud|remote)(?:$|[-_:/.])/i.test(name);

/** Accept only a numeric loopback endpoint; never follow redirects or use a proxy. */
function localEndpoint(value, backend) {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Укажите локальный адрес Qwen.');
  let url;
  try { url = new URL(value); } catch { throw new Error('Неверный адрес Qwen.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['','/','/v1','/v1/'].includes(url.pathname)) throw new Error('Qwen должен быть локальным: http://127.0.0.1:порт (или ::1).');
  if (backend === 'ollama' && !['','/'].includes(url.pathname)) throw new Error('Для Ollama укажите адрес без /v1 и /api.');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin + (backend === 'openai' ? '/v1' : '');
}
function settings(input) {
  const base = defaults();
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>!Object.hasOwn(base,key))) throw new Error('Неизвестные настройки Qwen.');
  const value = { ...base, ...input };
  if (!['ollama','openai'].includes(value.backend) || !['commands','dataset'].includes(value.mode) || typeof value.enabled !== 'boolean' || typeof value.require_owner !== 'boolean' || typeof value.model !== 'string' || value.model.length > 160 || /[\u0000-\u001f]/.test(value.model) || cloudModel(value.model)) throw new Error('Выберите установленную локальную модель и корректный режим.');
  if (!Number.isInteger(value.timeout_seconds) || value.timeout_seconds < 30 || value.timeout_seconds > 1800 || !Number.isInteger(value.cpu_threads) || value.cpu_threads < 1 || value.cpu_threads > 6 || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 1) throw new Error('Проверьте таймаут (30–1800 с), потоки (1–6) и температуру (0–1).');
  value.endpoint = localEndpoint(value.endpoint, value.backend);
  value.timezone = timezone(value.timezone);
  return value;
}

/** Read one bounded JSON response from a local HTTP server. */
function request(url, body, signal, timeout) {
  return new Promise((resolve,reject)=>{
    const controller = new AbortController();
    const abort = ()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(abort,timeout), bytes=[];
    let size=0, finished=false;
    const finish=(error,value)=>{
      if(finished) return;
      finished=true; clearTimeout(timer); signal?.removeEventListener('abort',abort);
      error ? reject(error) : resolve(value);
    };
    const data=body ? Buffer.from(JSON.stringify(body)) : null;
    const req=http.request(url,{ method:data?'POST':'GET',agent:false,signal:controller.signal,
      headers:{'Content-Type':'application/json',...(data?{'Content-Length':data.length}:{})}}, response=>{
      response.on('data',chunk=>{ size+=chunk.length; if(size>MAX_RESPONSE) { req.destroy(new Error('Слишком большой ответ Qwen.')); return; } bytes.push(chunk); });
      response.on('error',error=>finish(error));
      response.on('aborted',()=>finish(new Error('Локальный Qwen прервал ответ. Повторите запрос.')));
      response.on('end',()=>{
        try {
          if(response.statusCode<200 || response.statusCode>=300) throw new Error('Локальный Qwen: HTTP '+response.statusCode+'. Проверьте сервер, модель и поддержку JSON-схемы.');
          const value=JSON.parse(Buffer.concat(bytes).toString('utf8'));
          if(value.error) throw new Error('Qwen: '+String(value.error).slice(0,500));
          finish(null,value);
        } catch(error) { finish(error); }
      });
    });
    req.on('error',error=>finish(new Error(controller.signal.aborted ? signal?.aborted ? 'Обработка Qwen отменена.' : 'Истёк таймаут локального Qwen.' : 'Не удалось обратиться к локальному Qwen: '+error.message)));
    if(signal?.aborted) abort();
    req.end(data);
  });
}
class QwenLocal {
  async models(config, signal) {
    const value=settings(config), data=await request(value.endpoint+(value.backend==='ollama'?'/api/tags':'/models'),null,signal,10000);
    const rows=value.backend==='ollama'?data.models:data.data;
    if(!Array.isArray(rows)) throw new Error('Неверный список моделей локального сервера.');
    return rows.slice(0,100).map(item=>value.backend==='ollama'?item.name:item.id).filter(name=>typeof name==='string' && name.length<=160 && !cloudModel(name));
  }
  async infer(config, input, context, signal) {
    const value=settings(config);
    if(!value.model.trim()) throw new Error('Выберите установленную модель Qwen в настройках помощника.');
    const chat=messages(input,context);
    const body=value.backend==='ollama' ? {model:value.model,messages:chat,stream:false,format:SCHEMA,keep_alive:0,options:{temperature:value.temperature,num_thread:value.cpu_threads,num_gpu:0,num_ctx:4096,num_predict:512,seed:42}}
      : {model:value.model,messages:chat,stream:false,temperature:value.temperature,max_tokens:512,response_format:{type:'json_schema',json_schema:{name:'omni_intent',strict:true,schema:SCHEMA}}};
    const data=await request(value.endpoint+(value.backend==='ollama'?'/api/chat':'/chat/completions'),body,signal,value.timeout_seconds*1000);
    const message=value.backend==='ollama'?data.message:data.choices?.[0]?.message;
    if(!message || typeof message.content!=='string' || message.content.length>8192 || message.tool_calls?.length || (value.backend==='ollama' && data.done!==true) || (value.backend==='openai' && data.choices?.[0]?.finish_reason!=='stop')) throw new Error('Qwen не вернул завершённый ответ по JSON-схеме.');
    try { return JSON.parse(message.content); } catch { throw new Error('Qwen вернул некорректный JSON. Можно повторить запрос или исправить команду.'); }
  }
}
module.exports={QwenLocal,settings,defaults,localEndpoint,request};
