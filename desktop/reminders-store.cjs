const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { defaults, settings } = require('./qwen-local.cjs');
const { timezone, wallToUtc } = require('./reminder-time.cjs');
const { validId } = require('./voice-files.cjs');
const json = value => JSON.stringify(value);
const view = row => row && ({ ...row, intent:row.intent ? JSON.parse(row.intent) : null });

/** Own local SQLite data; transactions never overwrite recorder or Whisper files. */
class RemindersStore {
  constructor(directory) { this.folder=path.join(directory,'voice-assistant'); this.filename=path.join(this.folder,'reminders.sqlite'); this.db=null; }
  async open() {
    await fs.mkdir(this.folder,{recursive:true});
    try { const stat=await fs.lstat(this.filename); if(!stat.isFile() || stat.isSymbolicLink() || stat.size>128*1024*1024) throw new Error('Неверный или слишком большой файл базы напоминаний.'); } catch(error) { if(error.code!=='ENOENT') throw error; }
    this.db=new DatabaseSync(this.filename);
    try {
      const version=this.db.prepare('PRAGMA user_version').get().user_version;
      if(version>1) throw new Error('База создана более новой версией Omni.');
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;
        CREATE TABLE IF NOT EXISTS assistant_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audio_clips (id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT, spoken_at TEXT);
        CREATE TABLE IF NOT EXISTS transcriptions (clip_id TEXT PRIMARY KEY REFERENCES audio_clips(id), text TEXT NOT NULL, finished_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY REFERENCES audio_clips(id), text TEXT NOT NULL, spoken_at TEXT, timezone TEXT NOT NULL, selected_id TEXT, status TEXT NOT NULL, intent TEXT, message TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result_reminder_id TEXT);
        CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, source_clip_id TEXT UNIQUE NOT NULL REFERENCES proposals(id), title TEXT NOT NULL, due_at TEXT NOT NULL, timezone TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', progress_current INTEGER, progress_total INTEGER, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status,due_at);
        CREATE TABLE IF NOT EXISTS progress_events (id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id), source_clip_id TEXT NOT NULL REFERENCES proposals(id), kind TEXT NOT NULL, at TEXT NOT NULL, details TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS notification_deliveries (id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(id), due_revision INTEGER NOT NULL, delivered_at TEXT, UNIQUE(reminder_id,due_revision));
        PRAGMA user_version=1;`);
      this.db.prepare('INSERT OR IGNORE INTO assistant_settings VALUES (1,?)').run(json(defaults()));
      this.db.prepare("UPDATE proposals SET status='cancelled',message='Прервано при выходе; можно повторить.',revision=revision+1 WHERE status IN ('queued','running')").run();
      return this.config();
    } catch(error) { this.close(); throw error; }
  }
  config() { return settings(JSON.parse(this.db.prepare('SELECT value FROM assistant_settings WHERE id=1').get().value)); }
  configure(value) { const config=settings(value); this.db.prepare('UPDATE assistant_settings SET value=? WHERE id=1').run(json(config)); return config; }
  get(id) {
    if(!validId(id)) throw new Error('Неверный идентификатор команды.');
    const row=view(this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id));
    if(!row) throw new Error('Команда не найдена.');
    return row;
  }
  add(input, zone, now) {
    if(!validId(input.id) || typeof input.text!=='string' || !input.text.trim() || Buffer.byteLength(input.text)>8192) throw new Error('Команда должна содержать от 1 до 8192 байт текста.');
    const existing=this.db.prepare('SELECT id FROM proposals WHERE id=?').get(input.id);
    if(existing) return this.get(input.id);
    if(this.db.prepare('SELECT count(*) AS n FROM proposals').get().n>=5000) throw new Error('Каталог содержит 5000 команд; новые записи WAV продолжают сохраняться.');
    this.transaction(()=>{
      this.db.prepare('INSERT INTO audio_clips VALUES (?,?,?,?)').run(input.id,input.kind || 'audio',input.path || null,input.spoken_at || null);
      this.db.prepare('INSERT INTO transcriptions VALUES (?,?,?)').run(input.id,input.text,now);
      this.db.prepare("INSERT INTO proposals(id,text,spoken_at,timezone,selected_id,status,intent,message,created_at,updated_at) VALUES(?,?,?,?,?,'queued',NULL,'В очереди Qwen.',?,?)").run(input.id,input.text,input.spoken_at || null,timezone(zone),input.selected_id || null,now,now);
    });
    return this.get(input.id);
  }
  status(id, status, message, intent=null, now=new Date().toISOString()) {
    const row=this.get(id);
    if(['confirmed','rejected'].includes(row.status)) return row;
    this.db.prepare('UPDATE proposals SET status=?,message=?,intent=?,revision=revision+1,updated_at=? WHERE id=?').run(status,String(message).slice(0,1000),intent?json(intent):null,now,id);
    return this.get(id);
  }
  pending() { return this.db.prepare("SELECT id FROM proposals WHERE status='queued' ORDER BY created_at LIMIT 24").all().map(row=>row.id); }
  pendingCount() { return this.db.prepare("SELECT count(*) AS n FROM proposals WHERE status IN ('queued','running')").get().n; }
  cancelQueued(message) { this.db.prepare("UPDATE proposals SET status='cancelled',message=?,revision=revision+1 WHERE status='queued'").run(message); }
  list(query={}) {
    const {offset=0,limit=30,filter='all'}=query;
    if(!Number.isInteger(offset) || offset<0 || offset>100000 || !Number.isInteger(limit) || limit<1 || limit>50 || !['all','pending','error'].includes(filter)) throw new Error('Неверная страница команд.');
    const where=filter==='pending'?"WHERE status IN ('proposed','clarification','queued','running')":filter==='error'?"WHERE status IN ('error','cancelled')":'';
    return {total:this.db.prepare('SELECT count(*) AS n FROM proposals '+where).get().n,offset,items:this.db.prepare('SELECT * FROM proposals '+where+' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset).map(view)};
  }
  reminders(query={}) {
    const {offset=0,limit=30,status='open'}=query;
    if(!Number.isInteger(offset) || offset<0 || !Number.isInteger(limit) || limit<1 || limit>50 || !['all','open','done','cancelled'].includes(status)) throw new Error('Неверная страница напоминаний.');
    const where=status==='all'?'':'WHERE status=?', args=status==='all'?[]:[status];
    return {total:this.db.prepare('SELECT count(*) AS n FROM reminders '+where).get(...args).n,offset,items:this.db.prepare('SELECT * FROM reminders '+where+' ORDER BY due_at LIMIT ? OFFSET ?').all(...args,limit,offset)};
  }
  reminder(id) {
    if(!validId(id)) throw new Error('Неверный идентификатор задачи.');
    return this.db.prepare('SELECT * FROM reminders WHERE id=?').get(id) || null;
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=action(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reject(id, revision) {
    const row=this.get(id);
    if(row.status==='confirmed') throw new Error('Изменение уже подтверждено.');
    if(row.revision!==revision) throw new Error('Карточка изменилась. Откройте её повторно.');
    return this.status(id,'rejected','Отклонено пользователем.');
  }
  confirm(id, value, now=new Date().toISOString()) {
    const allowed=['revision','title','due_local','timezone','reminder_id','target_revision','progress_current','progress_total'];
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key)) || !Number.isInteger(value.revision)) throw new Error('Неверные параметры подтверждения.');
    return this.transaction(()=>{
      const row=this.get(id);
      if(row.status==='confirmed') return {proposal:row,reminder_id:row.result_reminder_id};
      if(!['proposed','clarification'].includes(row.status) || row.revision!==value.revision) throw new Error('Карточка изменилась. Откройте её повторно.');
      const type=row.intent?.type;
      if(!['create_reminder','reschedule_reminder','complete_reminder','update_progress','dataset_candidate'].includes(type)) throw new Error('Сначала уточните команду.');
      if(type==='dataset_candidate') {
        this.configure({...this.config(),mode:'dataset'});
        this.db.prepare("UPDATE proposals SET status='confirmed',message='Режим сбора датасета включён; микрофон не изменён.',revision=revision+1,updated_at=? WHERE id=?").run(now,id);
        return {proposal:this.get(id),reminder_id:null};
      }
      let target;
      if(type!=='create_reminder') {
        if(!validId(value.reminder_id)) throw new Error('Выберите конкретную задачу.');
        target=this.db.prepare('SELECT * FROM reminders WHERE id=?').get(value.reminder_id);
        if(!target || target.status!=='open' || target.revision!==value.target_revision) throw new Error('Задача изменилась или закрыта. Выберите её повторно.');
      }
      const title=type==='create_reminder'?value.title:target.title;
      if(typeof title!=='string' || !title.trim() || title.length>240) throw new Error('Укажите название задачи (до 240 символов).');
      let due=target?.due_at, zone=target?.timezone;
      if(['create_reminder','reschedule_reminder'].includes(type)) {
        zone=timezone(value.timezone); due=wallToUtc(value.due_local,zone);
        if(new Date(due)<=new Date(now)) throw new Error('Выберите будущее время: дата в карточке уже прошла.');
      }
      let current=null,total=null;
      if(type==='update_progress') {
        current=value.progress_current; total=value.progress_total;
        if(!Number.isInteger(current) || !Number.isInteger(total) || current<0 || total<1 || total>1000000 || current>total) throw new Error('Прогресс должен быть от 0 до общего количества.');
      }
      const reminderId=target?.id || randomUUID();
      if(type==='create_reminder') {
        if(this.db.prepare('SELECT count(*) AS n FROM reminders').get().n>=5000) throw new Error('Достигнут лимит 5000 напоминаний.');
        this.db.prepare('INSERT INTO reminders(id,source_clip_id,title,due_at,timezone,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(reminderId,id,title.trim(),due,zone,now,now);
      } else if(type==='reschedule_reminder') this.db.prepare('UPDATE reminders SET due_at=?,timezone=?,revision=revision+1,updated_at=? WHERE id=?').run(due,zone,now,reminderId);
      else if(type==='complete_reminder') this.db.prepare("UPDATE reminders SET status='done',revision=revision+1,updated_at=? WHERE id=?").run(now,reminderId);
      else this.db.prepare("UPDATE reminders SET progress_current=?,progress_total=?,status=?,revision=revision+1,updated_at=? WHERE id=?").run(current,total,current===total?'done':'open',now,reminderId);
      this.db.prepare('INSERT INTO progress_events VALUES(?,?,?,?,?,?)').run(randomUUID(),reminderId,id,type,now,json({title,due_at:due,timezone:zone,progress_current:current,progress_total:total}));
      this.db.prepare("UPDATE proposals SET status='confirmed',result_reminder_id=?,message='Подтверждено и сохранено.',revision=revision+1,updated_at=? WHERE id=?").run(reminderId,now,id);
      return {proposal:this.get(id),reminder_id:reminderId};
    });
  }
  history(id) {
    if(!validId(id) || !this.db.prepare('SELECT id FROM reminders WHERE id=?').get(id)) throw new Error('Задача не найдена.');
    return this.db.prepare('SELECT * FROM progress_events WHERE reminder_id=? ORDER BY at LIMIT 200').all(id).map(row=>({...row,details:JSON.parse(row.details)}));
  }
  close() { if(this.db) { this.db.close(); this.db=null; } }
}
module.exports={RemindersStore};
