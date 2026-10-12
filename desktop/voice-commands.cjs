const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { QwenLocal, defaults, settings } = require('./qwen-local.cjs');
const { RemindersStore } = require('./reminders-store.cjs');
const { wakeText, proposal } = require('./voice-intents.cjs');
const { readJson, validId } = require('./voice-files.cjs');
const MAX_PENDING=24;

/** Queue known transcripts, propose intents, and require explicit confirmation. */
class VoiceCommands {
  constructor(directory, speech, report=()=>{}, options={}) {
    this.directory=directory; this.speech=speech; this.report=report;
    this.store=new RemindersStore(directory); this.model=options.model || new QwenLocal();
    this.clock=options.clock || (()=>new Date()); this.checkOwner=options.checkOwner;
    this.config=defaults(); this.current=null; this.paused=false; this.closed=false;
    this.problem=''; this.owner=Symbol('qwen-cpu'); this.intake=new Set(); this.probe=null;
    this.selection=null;
    this.onIdle=()=>this.kick(); speech.on('idle',this.onIdle);
    this.ready=this.load();
  }
  async load() {
    try { this.config=await this.store.open(); }
    catch(error) { this.problem='База напоминаний: '+error.message; }
    this.publish();
  }
  async available() {
    await this.ready;
    if(this.closed) throw new Error('Помощник завершает работу.');
    if(!this.store.db) throw new Error(this.problem || 'База напоминаний недоступна.');
  }
  get busy() { return !!this.current || !!this.probe || this.intake.size>0 || (!this.paused && !this.closed && !!this.store.db && this.store.pending().length>0); }
  snapshot() {
    let pending=0;
    try { if(this.store.db) pending=this.store.pendingCount(); }
    catch(error) { this.paused=true; this.problem='База напоминаний: '+error.message; }
    return {busy:this.busy,processing:!!this.current,checking:!!this.probe,paused:this.paused,problem:this.problem,config:{...this.config},pending,limit:MAX_PENDING,
      message:this.current?'Qwen: '+(this.current.message || 'разбор команды…'):pending?'Qwen: ожидание CPU или очереди.':'Помощник готов; микрофон включается отдельно.',database:this.store.filename,selected_reminder_id:this.selection};
  }
  publish() { this.report(this.snapshot()); }
  async configure(input) {
    await this.available();
    const config=settings(input);
    if(this.probe || (this.current && config.enabled && config.mode==='commands')) throw new Error('Завершите или отмените текущий запрос Qwen.');
    this.config=this.store.configure(config);
    if(!config.enabled || config.mode==='dataset') this.cancel();
    this.publish(); return this.snapshot();
  }
  async models() {
    await this.available();
    if(this.probe || this.current) throw new Error('Уже выполняется запрос к Qwen.');
    const token={controller:new AbortController()}; this.probe=token; this.publish();
    token.done=this.model.models(this.config,token.controller.signal);
    try { return await token.done; } finally { if(this.probe===token)this.probe=null; this.publish(); this.kick(); }
  }
  async input(item) {
    const operation=this.receive(item); this.intake.add(operation); this.publish();
    try { return await operation; } finally { this.intake.delete(operation); this.publish(); }
  }
  async receive(item) {
    await this.available();
    if(!this.config.enabled || this.config.mode!=='commands' || item.status!=='done' || item.role && item.role!=='candidate') return null;
    const text=item.text;
    if(wakeText(text)===null) return null;
    let spokenAt=item.spoken_at || null;
    if(!spokenAt && typeof item.path==='string' && path.isAbsolute(item.path) && path.extname(item.path).toLowerCase()==='.wav') {
      try {
        const metadata=await readJson(item.path.slice(0,-4)+'.json',65536);
        if(metadata.id===item.id && typeof metadata.started_at==='string' && Number.isFinite(Date.parse(metadata.started_at))) spokenAt=new Date(metadata.started_at).toISOString();
      } catch {}
    }
    return this.enqueue({...item,text,spoken_at:spokenAt,kind:'audio',selected_id:this.selection});
  }
  async select(id) {
    await this.available();
    if(id!==null && (!validId(id) || this.store.reminder(id)?.status!=='open')) throw new Error('Выберите открытое напоминание.');
    this.selection=id; this.publish(); return this.snapshot();
  }
  async text(value) {
    await this.available();
    if(!value || typeof value!=='object' || Object.keys(value).some(key=>!['text','selected_id'].includes(key)) || typeof value.text!=='string' || !value.text.trim() || Buffer.byteLength(value.text)>8192 || (value.selected_id!=null && !validId(value.selected_id))) throw new Error('Введите команду (до 8192 байт).');
    return this.enqueue({id:'manual-'+randomUUID(),text:value.text,spoken_at:this.clock().toISOString(),kind:'manual',selected_id:value.selected_id || null});
  }
  enqueue(input) {
    const existing=this.store.db.prepare('SELECT id FROM proposals WHERE id=?').get(input.id);
    if(existing) return this.store.get(input.id);
    const now=this.clock().toISOString();
    const row=this.store.add(input,this.config.timezone,now);
    if(this.store.pendingCount()>MAX_PENDING) this.store.status(row.id,'error','Очередь заполнена: 24 команды. Текст и WAV сохранены; повторите позже.');
    else if(!wakeText(input.text)?.trim() && input.kind!=='manual') this.store.status(row.id,'clarification','После «Омни» скажите команду.',{type:'clarify',question:'Что сделать?',needs_confirmation:true});
    else {
      this.paused=false; this.problem='';
    }
    this.publish(); this.kick(); return this.store.get(row.id);
  }
  kick() {
    if(this.closed || this.paused || this.current || this.probe || !this.store.db) return;
    let id;
    try { id=this.store.pending()[0]; }
    catch(error) { this.paused=true; this.problem='База напоминаний: '+error.message; this.publish(); return; }
    if(!id) return;
    if(!this.speech.reserveBackground?.(this.owner)) return;
    try { this.speech.session?.close(); }
    catch(error) {
      this.paused=true; this.problem=error.message;
      this.store.status(id,'error',error.message);
      this.speech.releaseBackground(this.owner); this.publish(); return;
    }
    const token={id,controller:new AbortController(),message:'разбор команды…'};
    this.current=token;
    token.done=this.run(token).catch(error=>{
      this.paused=true; this.problem='База напоминаний: '+error.message;
    }).finally(()=>{
      if(this.current===token)this.current=null;
      this.speech.releaseBackground?.(this.owner); this.publish(); this.kick();
    });
    this.publish();
  }
  async run(token) {
    const row=this.store.get(token.id), config={...this.config};
    const selectedId=row.selected_id || null;
    try {
      this.store.status(row.id,'running','Разбор локальным Qwen…');
      if(config.require_owner && row.id.indexOf('manual-')!==0) {
        token.message='проверка владельца голоса…'; this.publish();
        if(!this.checkOwner || !await this.checkOwner(row.id,token.controller.signal)) throw new Error('Голос не подтверждён. Проверьте запись в разделе датасета; команду можно повторить.');
      }
      if(token.controller.signal.aborted) throw new Error('Обработка Qwen отменена.');
      const input={id:row.id,text:row.text,spoken_at:row.spoken_at};
      const reminders=this.store.reminders({limit:50}).items;
      const selected=selectedId && this.store.reminder(selectedId);
      if(selected?.status==='open') {
        const index=reminders.findIndex(item=>item.id===selectedId);
        if(index>=0)reminders.splice(index,1);
        reminders.unshift(selected);
      }
      const context={timezone:row.timezone,selected_id:selectedId,reminders};
      token.message='разбор команды…'; this.publish();
      const value=await this.model.infer(config,input,context,token.controller.signal);
      if(token.controller.signal.aborted) throw new Error('Обработка Qwen отменена.');
      const intent=proposal(value,input,context);
      const target=reminders.find(item=>item.id===intent.reminder_id);
      if(target) intent.target_revision=target.revision;
      if(intent.due_at && new Date(intent.due_at)<=this.clock()) { intent.due_at=null; intent.due_local=''; intent.question='Время из записи уже прошло. Выберите новую дату.'; }
      this.store.status(row.id,intent.type==='ignore'?'ignored':intent.question && intent.type!=='dataset_candidate'?'clarification':'proposed',intent.question || 'Проверьте карточку и подтвердите.',intent,this.clock().toISOString());
    } catch(error) {
      const cancelled=token.controller.signal.aborted;
      this.store.status(row.id,cancelled?'cancelled':'error',error.message,null,this.clock().toISOString());
      if(!cancelled) {this.paused=true;this.problem=error.message;}
      try { await fs.writeFile(path.join(this.directory,'voice-qwen.log'),JSON.stringify({at:this.clock().toISOString(),endpoint:config.endpoint,model:config.model,source_clip_id:row.id,error:error.message},null,2)); } catch {}
    }
  }
  async list(query) { await this.available(); return this.store.list(query); }
  async reminders(query) { await this.available(); return this.store.reminders(query); }
  async history(id) { await this.available(); return this.store.history(id); }
  async retry(id) {
    await this.available(); const row=this.store.get(id);
    if(!['error','cancelled'].includes(row.status)) throw new Error('Можно повторить только ошибку или отменённый запрос.');
    if(this.store.pendingCount()>=MAX_PENDING) throw new Error('Очередь заполнена.');
    this.store.status(id,'queued','В очереди Qwen.'); this.paused=false;this.problem='';this.publish();this.kick();return this.snapshot();
  }
  async reject(id, revision) { await this.available(); const result=this.store.reject(id,revision); this.publish(); return result; }
  async confirm(id,value) {
    await this.available(); const result=this.store.confirm(id,value,this.clock().toISOString());
    this.config=this.store.config();
    if(this.selection && this.store.reminder(this.selection)?.status!=='open') this.selection=null;
    if(this.config.mode==='dataset') this.cancel();
    this.publish(); return result;
  }
  cancel() {
    this.paused=true;this.current?.controller.abort();this.probe?.controller.abort();
    try { if(this.store.db) this.store.cancelQueued('Отменено пользователем.'); }
    catch(error) { this.problem='База напоминаний: '+error.message; }
    this.publish();return this.snapshot();
  }
  async shutdown() {
    this.closed=true;this.cancel();await this.ready;
    await Promise.allSettled([...this.intake,this.current?.done,this.probe?.done].filter(Boolean));
    this.speech.off('idle',this.onIdle);this.store.close();
  }
}
module.exports={VoiceCommands};
