import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, Subject, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import { ConflictItem, HandoverRecord, HandoverRequest, initialSession, RehearsalSession } from './state/rehearsal.reducer';

const DB_KEY = 'yf52-rehearsal-server-db';

interface ServerDB {
  sessions: RehearsalSession[];
  auditLog: HandoverRecord[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadDB(): ServerDB {
  if (typeof localStorage === 'undefined') return { sessions: [initialSession()], auditLog: [] };
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw) as ServerDB;
  } catch { /* 损坏则重建 */ }
  const db: ServerDB = { sessions: [initialSession()], auditLog: [] };
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  return db;
}

function saveDB(db: ServerDB): void {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

export type HandoverResult =
  | { type: 'accepted'; record: HandoverRecord; session: RehearsalSession }
  | { type: 'rejected'; record: HandoverRecord; reason: string; conflicts?: ConflictItem[] }
  | { type: 'failed'; error: string };

/**
 * 排练服务器（模拟后端）：
 * - 场次版本号乐观并发控制
 * - 已结束场次拒绝新请求
 * - 保存失败可注入（模拟 500）
 * - 跨窗口通过 storage 事件同步
 */
@Injectable({ providedIn: 'root' })
export class RehearsalServer {
  private readonly sessionsSubject$ = new BehaviorSubject<RehearsalSession[]>([]);
  private readonly historySubject$ = new BehaviorSubject<HandoverRecord[]>([]);
  private readonly updatesSubject$ = new Subject<void>();
  private simulateFailure = false;

  constructor() {
    this.refresh();
    window.addEventListener('storage', (event) => {
      if (event.key === DB_KEY) {
        this.refresh();
        this.updatesSubject$.next();
      }
    });
  }

  refresh(): void {
    const db = loadDB();
    this.sessionsSubject$.next(clone(db.sessions));
    this.historySubject$.next(clone(db.auditLog));
  }

  sessions(): Observable<RehearsalSession[]> {
    return this.sessionsSubject$.asObservable();
  }

  history(): Observable<HandoverRecord[]> {
    return this.historySubject$.asObservable();
  }

  /** 其他窗口改动了服务器数据时发出 */
  serverUpdates(): Observable<void> {
    return this.updatesSubject$.asObservable();
  }

  setSimulateFailure(on: boolean): void {
    this.simulateFailure = on;
  }

  submitHandover(req: HandoverRequest): Observable<HandoverResult> {
    if (this.simulateFailure) {
      return timer(400).pipe(map(() => ({ type: 'failed' as const, error: '模拟保存失败：服务器返回 500，请求已保留待重试' })));
    }
    return timer(320 + Math.random() * 420).pipe(
      map(() => {
        const db = loadDB();
        const session = db.sessions.find((item) => item.id === req.sessionId);
        const now = Date.now();

        if (!session) {
          const record = this.record(req, -1, 'rejected', '场次不存在', now);
          db.auditLog.push(record);
          saveDB(db);
          this.refresh();
          return { type: 'rejected', record, reason: '场次不存在' };
        }

        if (session.status === 'ended') {
          const record = this.record(req, session.version, 'rejected', '场次已结束，不能提交换人请求', now);
          db.auditLog.push(record);
          saveDB(db);
          this.refresh();
          return { type: 'rejected', record, reason: '场次已结束，不能提交换人请求' };
        }

        if (req.baseVersion < session.version) {
          const conflicts: ConflictItem[] = db.auditLog
            .filter((item) => item.sessionId === req.sessionId && item.result === 'accepted' && item.version > req.baseVersion)
            .sort((a, b) => a.version - b.version)
            .map((item) => ({ version: item.version, role: item.role, from: item.fromActor, to: item.toActor, at: item.at }));
          const reason = `版本冲突：场次已更新到 v${session.version}，你的请求基于 v${req.baseVersion}`;
          const record = this.record(req, session.version, 'rejected', reason, now, conflicts);
          db.auditLog.push(record);
          saveDB(db);
          this.refresh();
          return { type: 'rejected', record, reason, conflicts };
        }

        // 生效交接：应用归属规则后版本 +1
        applyHandover(session, req);
        session.version += 1;
        const record = this.record(req, session.version, 'accepted', undefined, now);
        db.auditLog.push(record);
        saveDB(db);
        this.refresh();
        return { type: 'accepted', record, session: clone(session) };
      })
    );
  }

  endSession(sessionId: string): Observable<RehearsalSession | null> {
    return timer(300).pipe(
      map(() => {
        const db = loadDB();
        const session = db.sessions.find((item) => item.id === sessionId);
        if (!session) return null;
        session.status = 'ended';
        saveDB(db);
        this.refresh();
        return clone(session);
      })
    );
  }

  markLineRead(sessionId: string, lineId: string, read: boolean): Observable<RehearsalSession | null> {
    return timer(180).pipe(
      map(() => {
        const db = loadDB();
        const session = db.sessions.find((item) => item.id === sessionId);
        if (!session) return null;
        const line = session.lines.find((item) => item.id === lineId);
        if (line) {
          line.read = read;
          line.readBy = read ? line.actor : undefined;
        }
        saveDB(db);
        this.refresh();
        return clone(session);
      })
    );
  }

  private record(
    req: HandoverRequest,
    version: number,
    result: HandoverRecord['result'],
    reason: string | undefined,
    at: number,
    conflicts?: ConflictItem[]
  ): HandoverRecord {
    return {
      id: `h${at}_${Math.random().toString(36).slice(2, 7)}`,
      requestId: req.id,
      sessionId: req.sessionId,
      role: req.role,
      fromActor: req.fromActor,
      toActor: req.toActor,
      version,
      result,
      reason,
      conflicts,
      at
    };
  }
}

/**
 * 交接归属规则：
 * - 已读台词：readBy 记原演员，不随角色转走
 * - 未读台词：actor 归接替者
 * - 场记提示：actor 归接替者
 * - 演员私下疑问：actor 保持原提问者，不随角色转走
 */
function applyHandover(session: RehearsalSession, req: HandoverRequest): void {
  const role = session.roles.find((item) => item.role === req.role);
  if (role) role.actor = req.toActor;

  for (const line of session.lines) {
    if (line.role !== req.role) continue;
    if (!line.read) line.actor = req.toActor;
    // 已读台词的 readBy 已记录原演员，保持不变
  }

  for (const cue of session.cues) {
    if (cue.role === req.role) cue.actor = req.toActor;
  }
  // questions.actor 不随角色转走
}
