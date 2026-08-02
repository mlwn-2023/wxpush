import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function createStore(filename) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS recipients (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,openid TEXT NOT NULL UNIQUE,group_name TEXT NOT NULL DEFAULT '默认分组',enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,content TEXT NOT NULL,recipients TEXT NOT NULL,recipient_count INTEGER NOT NULL,success_count INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,error TEXT,source TEXT NOT NULL DEFAULT 'console',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS message_templates (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,token_prefix TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,last_used_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,recipient_ids TEXT NOT NULL DEFAULT '[]',send_all INTEGER NOT NULL DEFAULT 1,recurrence TEXT NOT NULL DEFAULT 'once',next_run_at TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,last_run_at TEXT,last_status TEXT,last_error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  ensureColumn(db, 'messages', 'public_id', 'TEXT');
  ensureColumn(db, 'messages', 'attempts', 'INTEGER NOT NULL DEFAULT 1');
  db.exec("UPDATE messages SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id=''");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_public_id ON messages(public_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled,next_run_at)');

  const q = {
    getSetting: db.prepare('SELECT value FROM settings WHERE key=?'),
    setSetting: db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`),
    listRecipients: db.prepare('SELECT id,name,openid,group_name,enabled,created_at FROM recipients ORDER BY enabled DESC,id DESC'),
    getRecipient: db.prepare('SELECT * FROM recipients WHERE id=?'),
    addRecipient: db.prepare('INSERT INTO recipients(name,openid,group_name,enabled) VALUES(?,?,?,?)'),
    updateRecipient: db.prepare('UPDATE recipients SET name=?,openid=?,group_name=?,enabled=? WHERE id=?'),
    deleteRecipient: db.prepare('DELETE FROM recipients WHERE id=?'),
    enabledRecipients: db.prepare('SELECT openid FROM recipients WHERE enabled=1 ORDER BY id'),
    addMessage: db.prepare(`INSERT INTO messages(public_id,title,content,recipients,recipient_count,success_count,status,error,source,attempts) VALUES(?,?,?,?,?,?,?,?,?,?)`),
    updateMessage: db.prepare('UPDATE messages SET success_count=?,status=?,error=?,attempts=? WHERE id=?'),
    getMessage: db.prepare('SELECT * FROM messages WHERE id=?'),
    getMessageByPublicId: db.prepare('SELECT id,public_id,title,content,status,created_at FROM messages WHERE public_id=?'),
    listMessages: db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?'),
    allMessages: db.prepare('SELECT * FROM messages ORDER BY id DESC'),
    deleteMessage: db.prepare('DELETE FROM messages WHERE id=?'),
    deleteAllMessages: db.prepare('DELETE FROM messages'),
    cleanupMessages: db.prepare("DELETE FROM messages WHERE created_at < datetime('now', ? )"),
    stats: db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) success,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,SUM(CASE WHEN date(created_at,'localtime')=date('now','localtime') THEN 1 ELSE 0 END) today FROM messages`),
    addSession: db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)'), getSession: db.prepare('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?'), deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash=?'), cleanupSessions: db.prepare('DELETE FROM sessions WHERE expires_at<=?'),
    listTemplates: db.prepare('SELECT * FROM message_templates ORDER BY updated_at DESC,id DESC'), getTemplate: db.prepare('SELECT * FROM message_templates WHERE id=?'), addTemplate: db.prepare('INSERT INTO message_templates(name,title,content) VALUES(?,?,?)'), updateTemplate: db.prepare('UPDATE message_templates SET name=?,title=?,content=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'), deleteTemplate: db.prepare('DELETE FROM message_templates WHERE id=?'),
    listTokens: db.prepare('SELECT id,name,token_prefix,enabled,last_used_at,created_at FROM api_tokens ORDER BY id DESC'), addToken: db.prepare('INSERT INTO api_tokens(name,token_hash,token_prefix) VALUES(?,?,?)'), setTokenEnabled: db.prepare('UPDATE api_tokens SET enabled=? WHERE id=?'), deleteToken: db.prepare('DELETE FROM api_tokens WHERE id=?'), findToken: db.prepare('SELECT id FROM api_tokens WHERE token_hash=? AND enabled=1'), touchToken: db.prepare('UPDATE api_tokens SET last_used_at=CURRENT_TIMESTAMP WHERE id=?'),
    listSchedules: db.prepare('SELECT * FROM schedules ORDER BY enabled DESC,next_run_at ASC,id DESC'), getSchedule: db.prepare('SELECT * FROM schedules WHERE id=?'), addSchedule: db.prepare('INSERT INTO schedules(name,title,content,recipient_ids,send_all,recurrence,next_run_at,enabled) VALUES(?,?,?,?,?,?,?,?)'), updateSchedule: db.prepare('UPDATE schedules SET name=?,title=?,content=?,recipient_ids=?,send_all=?,recurrence=?,next_run_at=?,enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'), deleteSchedule: db.prepare('DELETE FROM schedules WHERE id=?'), dueSchedules: db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 20"), updateScheduleRun: db.prepare('UPDATE schedules SET enabled=?,next_run_at=?,last_run_at=CURRENT_TIMESTAMP,last_status=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
  };

  const decodeMessage = m => m ? { ...m, recipients: safeJson(m.recipients, []) } : null;
  const decodeSchedule = s => s ? { ...s, recipient_ids: safeJson(s.recipient_ids, []), send_all: Boolean(s.send_all), enabled: Boolean(s.enabled) } : null;
  return {
    db, filename,
    getSetting(key, fallback='') { return q.getSetting.get(key)?.value ?? fallback; }, setSetting(key,value) { q.setSetting.run(key,String(value ?? '')); },
    listRecipients() { return q.listRecipients.all().map(r=>({...r,enabled:Boolean(r.enabled)})); }, getRecipient(id) { return q.getRecipient.get(id); }, addRecipient(v) { return Number(q.addRecipient.run(v.name,v.openid,v.group_name||'默认分组',v.enabled===false?0:1).lastInsertRowid); }, updateRecipient(id,v) { return q.updateRecipient.run(v.name,v.openid,v.group_name||'默认分组',v.enabled===false?0:1,id).changes; }, deleteRecipient(id) { return q.deleteRecipient.run(id).changes; }, enabledOpenids() { return q.enabledRecipients.all().map(r=>r.openid); },
    addMessage(v) { return Number(q.addMessage.run(v.publicId||randomBytes(16).toString('hex'),v.title,v.content,JSON.stringify(v.recipients),v.recipients.length,v.successCount||0,v.status,v.error||null,v.source||'console',v.attempts||1).lastInsertRowid); }, updateMessage(id,v) { q.updateMessage.run(v.successCount||0,v.status,v.error||null,v.attempts||1,id); }, getMessage(id) { return decodeMessage(q.getMessage.get(id)); }, getMessageByPublicId(id) { return q.getMessageByPublicId.get(id); }, listMessages(limit=100) { return q.listMessages.all(Math.min(Math.max(Number(limit)||100,1),500)).map(decodeMessage); }, allMessages() { return q.allMessages.all().map(decodeMessage); }, deleteMessage(id) { return q.deleteMessage.run(id).changes; }, deleteMessages(ids) { let n=0; db.exec('BEGIN'); try { for(const id of ids)n+=Number(q.deleteMessage.run(id).changes); db.exec('COMMIT'); } catch(e){db.exec('ROLLBACK');throw e;} return n; }, deleteAllMessages(){return Number(q.deleteAllMessages.run().changes);}, cleanupMessages(days){return Number(q.cleanupMessages.run(`-${Math.max(1,Number(days)||90)} days`).changes);},
    stats() { const s=q.stats.get(); return {total:Number(s.total||0),success:Number(s.success||0),failed:Number(s.failed||0),today:Number(s.today||0),recipients:this.listRecipients().filter(r=>r.enabled).length}; },
    addSession(h,e){q.addSession.run(h,e);},hasSession(h,n){return Boolean(q.getSession.get(h,n));},deleteSession(h){q.deleteSession.run(h);},cleanupSessions(n){q.cleanupSessions.run(n);},
    listTemplates(){return q.listTemplates.all();},getTemplate(id){return q.getTemplate.get(id);},addTemplate(v){return Number(q.addTemplate.run(v.name,v.title,v.content).lastInsertRowid);},updateTemplate(id,v){return q.updateTemplate.run(v.name,v.title,v.content,id).changes;},deleteTemplate(id){return q.deleteTemplate.run(id).changes;},
    listTokens(){return q.listTokens.all().map(t=>({...t,enabled:Boolean(t.enabled)}));},addToken(v){return Number(q.addToken.run(v.name,v.tokenHash,v.prefix).lastInsertRowid);},setTokenEnabled(id,enabled){return q.setTokenEnabled.run(enabled?1:0,id).changes;},deleteToken(id){return q.deleteToken.run(id).changes;},validateToken(hash){const row=q.findToken.get(hash);if(!row)return false;q.touchToken.run(row.id);return true;},
    listSchedules(){return q.listSchedules.all().map(decodeSchedule);},getSchedule(id){return decodeSchedule(q.getSchedule.get(id));},addSchedule(v){return Number(q.addSchedule.run(v.name,v.title,v.content,JSON.stringify(v.recipientIds),v.sendAll?1:0,v.recurrence,v.nextRunAt,v.enabled===false?0:1).lastInsertRowid);},updateSchedule(id,v){return q.updateSchedule.run(v.name,v.title,v.content,JSON.stringify(v.recipientIds),v.sendAll?1:0,v.recurrence,v.nextRunAt,v.enabled===false?0:1,id).changes;},deleteSchedule(id){return q.deleteSchedule.run(id).changes;},dueSchedules(now){return q.dueSchedules.all(now).map(decodeSchedule);},updateScheduleRun(id,v){q.updateScheduleRun.run(v.enabled?1:0,v.nextRunAt,v.status,v.error||null,id);},
    checkpoint(){db.exec('PRAGMA wal_checkpoint(FULL)');},close(){db.close();}
  };
}

function ensureColumn(db,table,column,definition){const columns=db.prepare(`PRAGMA table_info(${table})`).all();if(!columns.some(c=>c.name===column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function safeJson(value,fallback){try{return JSON.parse(value);}catch{return fallback;}}
