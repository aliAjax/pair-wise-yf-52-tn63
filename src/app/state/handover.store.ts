import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import {
  AuditEntry,
  HandoverResult,
  HandoverServerState,
  PendingHandover,
  RehearsalSession,
} from './handover.model';
import { applyHandover, mergePending, uid } from './handover.logic';

const SERVER_KEY = 'yf52-handover-server';
const QUEUE_KEY_PREFIX = 'yf52-handover-queue';
const LOCAL_AUDIT_KEY_PREFIX = 'yf52-handover-local-audit';
const FAIL_BUDGET_KEY = 'yf52-handover-fail-budget';

/** 窗口身份：同一标签页内稳定，不同窗口互不相同。 */
function getWindowId(): string {
  if (typeof sessionStorage === 'undefined') return 'win-server';
  let id = sessionStorage.getItem('yf52-window-id');
  if (!id) {
    id = `窗口-${Math.floor(Math.random() * 900 + 100)}`;
    sessionStorage.setItem('yf52-window-id', id);
  }
  return id;
}

export interface SubmitResponse {
  /** 已在服务器生效或被服务器明确拒绝/判定冲突。 */
  immediate?: HandoverResult;
  /** 断网或保存失败，请求留在本机。 */
  queued?: PendingHandover;
  queuedReason?: 'offline' | 'save-failed';
}

@Injectable({ providedIn: 'root' })
export class HandoverStore {
  readonly windowId = getWindowId();
  private readonly serverSubject = new BehaviorSubject<HandoverServerState>(this.loadServer());
  readonly server$: Observable<HandoverServerState> = this.serverSubject.asObservable();

  private readonly queueSubject = new BehaviorSubject<PendingHandover[]>(this.loadQueue());
  readonly queue$: Observable<PendingHandover[]> = this.queueSubject.asObservable();

  private readonly localAuditSubject = new BehaviorSubject<AuditEntry[]>(this.loadLocalAudit());
  readonly localAudit$: Observable<AuditEntry[]> = this.localAuditSubject.asObservable();

  private readonly onlineSubject = new BehaviorSubject<boolean>(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  readonly online$: Observable<boolean> = this.onlineSubject.asObservable();

  private retryTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.setOnline(true));
      window.addEventListener('offline', () => this.setOnline(false));
      // 另一窗口写入"服务器"后，本窗口实时同步；提交时还会再强制重读一次。
      window.addEventListener('storage', (event) => {
        if (event.key === SERVER_KEY && event.newValue) {
          try {
            this.serverSubject.next(JSON.parse(event.newValue) as HandoverServerState);
          } catch {
            /* 忽略损坏的缓存 */
          }
        }
      });
      // 在线时每隔几秒自动重试本机待发请求。
      this.retryTimer = setInterval(() => {
        if (this.onlineSubject.value && this.queueSubject.value.length > 0) this.flushQueue();
      }, 4000);
    }
  }

  get server(): HandoverServerState {
    return this.serverSubject.value;
  }
  get queue(): PendingHandover[] {
    return this.queueSubject.value;
  }
  get online(): boolean {
    return this.onlineSubject.value;
  }

  setOnline(online: boolean): void {
    const wasOffline = !this.onlineSubject.value;
    this.onlineSubject.next(online);
    if (online && wasOffline) this.flushQueue();
  }

  /** 演示用：让接下来 n 次服务器保存失败（模拟服务端 500 / 存储不可写）。 */
  armSaveFailures(n: number): void {
    localStorage.setItem(FAIL_BUDGET_KEY, String(n));
  }

  private failBudget(): number {
    return Number(localStorage.getItem(FAIL_BUDGET_KEY) ?? 0);
  }

  private loadServer(): HandoverServerState {
    if (typeof localStorage === 'undefined') return seedState();
    const raw = localStorage.getItem(SERVER_KEY);
    if (raw) {
      try {
        return JSON.parse(raw) as HandoverServerState;
      } catch {
        /* fall through to seed */
      }
    }
    const seeded = seedState();
    localStorage.setItem(SERVER_KEY, JSON.stringify(seeded));
    return seeded;
  }

  private queueKey(): string {
    return `${QUEUE_KEY_PREFIX}-${this.windowId}`;
  }

  private loadQueue(): PendingHandover[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      return JSON.parse(localStorage.getItem(this.queueKey()) ?? '[]') as PendingHandover[];
    } catch {
      return [];
    }
  }

  private persistQueue(queue: PendingHandover[]): void {
    localStorage.setItem(this.queueKey(), JSON.stringify(queue));
    this.queueSubject.next(queue);
  }

  private localAuditKey(): string {
    return `${LOCAL_AUDIT_KEY_PREFIX}-${this.windowId}`;
  }

  private loadLocalAudit(): AuditEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      return JSON.parse(localStorage.getItem(this.localAuditKey()) ?? '[]') as AuditEntry[];
    } catch {
      return [];
    }
  }

  private addLocalAudit(entry: Omit<AuditEntry, 'id' | 'at' | 'windowId'>): AuditEntry {
    const full: AuditEntry = { ...entry, id: uid('au'), at: Date.now(), windowId: this.windowId };
    const next = [full, ...this.localAuditSubject.value];
    localStorage.setItem(this.localAuditKey(), JSON.stringify(next));
    this.localAuditSubject.next(next);
    return full;
  }

  /** 写共享"服务器"。返回 false 表示本次保存失败（调用方必须保留请求并重试）。 */
  private saveServer(next: HandoverServerState): boolean {
    if (this.failBudget() > 0) {
      localStorage.setItem(FAIL_BUDGET_KEY, String(this.failBudget() - 1));
      return false;
    }
    try {
      localStorage.setItem(SERVER_KEY, JSON.stringify(next));
      this.serverSubject.next(next);
      return true;
    } catch {
      return false;
    }
  }

  /** 提交时强制重读共享服务器，作为乐观并发比对的基准。 */
  private latestFromStorage(): HandoverServerState {
    try {
      const raw = localStorage.getItem(SERVER_KEY);
      if (raw) return JSON.parse(raw) as HandoverServerState;
    } catch {
      /* 用内存值 */
    }
    return this.serverSubject.value;
  }

  submit(input: {
    sessionId: string;
    roleId: string;
    fromActorId: string;
    toActorId: string;
    reason: string;
    baseVersion: number;
  }): SubmitResponse {
    const now = Date.now();
    const pending: PendingHandover = {
      id: uid('pend'),
      sessionId: input.sessionId,
      roleId: input.roleId,
      fromActorId: input.fromActorId,
      toActorId: input.toActorId,
      reason: input.reason,
      baseVersion: input.baseVersion,
      createdAt: now,
      attempts: 0,
    };

    if (!this.onlineSubject.value) {
      this.keepPending(pending, 'offline');
      return { queued: pending, queuedReason: 'offline' };
    }

    const latest = this.latestFromStorage();
    const { state: next, result } = applyHandover({
      state: latest,
      ...input,
      windowId: this.windowId,
      at: now,
    });

    // 冲突/拒绝不改业务数据，仅追加审计；保存失败也先在内存中给出明确结果。
    if (result.status === 'applied') {
      const saved = this.saveServer(next);
      if (!saved) {
        this.keepPending({ ...pending, attempts: 1, lastError: '服务器保存失败（已模拟）' }, 'save-failed');
        return { queued: pending, queuedReason: 'save-failed' };
      }
      return { immediate: result };
    }

    // 冲突/拒绝不改业务数据，仅追加审计；保存失败也先在内存中给出明确结果，
    // 并把原因补记到本窗口审计，保证"每次拒绝的原因"都查得到。
    const saved = this.saveServer(next);
    if (!saved) {
      this.serverSubject.next(next);
      this.addLocalAudit({
        sessionId: result.sessionId,
        type: result.status === 'conflict' ? 'handover-conflict' : 'handover-rejected',
        summary: result.audit.summary,
        detail: result.audit.detail,
      });
    }
    return { immediate: result };
  }

  private keepPending(pending: PendingHandover, why: 'offline' | 'save-failed'): void {
    this.persistQueue([...this.queueSubject.value, pending]);
    this.addLocalAudit({
      sessionId: pending.sessionId,
      type: why === 'offline' ? 'queue-kept' : 'save-failed',
      summary:
        why === 'offline'
          ? `断网：换人请求（${pending.fromActorId} → ${pending.toActorId}）留在本机 v${pending.baseVersion}`
          : `保存失败：换人请求（${pending.fromActorId} → ${pending.toActorId}）继续保留，将自动重试`,
      detail:
        why === 'offline'
          ? '网络恢复后将按场次版本合并；若期间已有他人交接生效，会列出冲突条目。'
          : pending.lastError,
    });
  }

  /** 网络恢复 / 手动触发：按提交顺序把本机请求与服务器按场次版本合并。 */
  flushQueue(): { processed: number; remaining: number } {
    const queue = this.queueSubject.value;
    const keep: PendingHandover[] = [];
    let index = 0;

    // 逐条提交，服务器版本始终从最新状态推进。
    let current = this.onlineSubject.value ? this.latestFromStorage() : this.serverSubject.value;

    for (; index < queue.length; index++) {
      if (!this.onlineSubject.value) break; // 又断网了，剩余全部保留
      const attempt: PendingHandover = { ...queue[index], attempts: queue[index].attempts + 1 };
      const { state: next, result } = mergePending(current, attempt, this.windowId, Date.now());
      // 无论生效、冲突还是拒绝，都是"明确结果"：成功保存后从本机队列移除。
      const saved = this.saveServer(next);
      if (!saved) {
        // 保存失败：当前请求（记一次尝试）及后续请求继续留在本机，等待重试。
        keep.push({ ...attempt, lastError: '服务器保存失败（已模拟）' });
        index += 1; // break 不会自增，跳过当前项后再收集剩余请求
        break;
      }
      current = next;
      this.addLocalAudit({
        sessionId: attempt.sessionId,
        type:
          result.status === 'applied'
            ? 'handover-applied'
            : result.status === 'conflict'
              ? 'handover-conflict'
              : 'handover-rejected',
        summary: `本机请求合并完成：${result.status === 'applied' ? '已生效' : result.status === 'conflict' ? '版本冲突，未覆盖已有交接' : '被拒绝'}`,
        detail:
          result.status === 'applied'
            ? result.handover
              ? `v${result.baseVersion} → v${result.currentVersion}；转交台词 ${result.handover.transferredLineIds.length} 条、提示 ${result.handover.transferredCueIds.length} 条`
              : undefined
            : result.status === 'conflict'
              ? result.conflicts.map((c) => `· ${c.label}：${c.detail}`).join('\n')
              : result.rejectReason,
      });
    }

    // break 之后未尝试的请求原样保留（含断网场景）。
    for (; index < queue.length; index++) keep.push(queue[index]);

    const changed =
      keep.length !== queue.length ||
      keep.some((item, i) => item.attempts !== queue[i]?.attempts || item.lastError !== queue[i]?.lastError);
    if (changed) this.persistQueue(keep);
    return { processed: queue.length - keep.length, remaining: keep.length };
  }

  /** 舞台监督结束场次：之后所有换人请求都会得到"场次已结束"的明确拒绝。 */
  endSession(sessionId: string): boolean {
    const latest = this.latestFromStorage();
    const next: HandoverServerState = {
      ...latest,
      sessions: latest.sessions.map((s) =>
        s.id === sessionId && s.status === 'rehearsing'
          ? ({ ...s, status: 'ended' as const } satisfies RehearsalSession)
          : s,
      ),
    };
    const saved = this.saveServer(next);
    if (saved) {
      this.addLocalAudit({
        sessionId,
        type: 'session-ended',
        summary: `舞台监督结束场次，结束时版本 v${latest.sessions.find((s) => s.id === sessionId)?.version}`,
      });
    }
    return saved;
  }
}

function seedState(): HandoverServerState {
  const now = Date.now();
  return {
    actors: [
      { id: 'a-suwan', name: '苏婉' },
      { id: 'a-hezheng', name: '何铮' },
      { id: 'a-bailu', name: '白露' },
      { id: 'a-jinchuan', name: '金川' },
    ],
    sessions: [
      {
        id: 's3',
        title: '第三场 · 父女冲突',
        status: 'rehearsing',
        version: 2,
        roles: [
          { roleId: 'r-zhoulan', roleName: '周岚', currentActorId: 'a-suwan' },
          { roleId: 'r-zhouye', roleName: '周野', currentActorId: 'a-hezheng' },
        ],
        lines: [
          { id: 'l1', roleId: 'r-zhoulan', text: '你每次都说等明天，可舞台不会等我们。', read: true, readByActorId: 'a-suwan', currentActorId: 'a-suwan' },
          { id: 'l2', roleId: 'r-zhoulan', text: '（低声）灯要是真灭了，你敢不敢一个人站在台上。', read: false, currentActorId: 'a-suwan' },
          { id: 'l3', roleId: 'r-zhouye', text: '那就让灯灭吧，我早已背熟黑暗。', read: true, readByActorId: 'a-hezheng', currentActorId: 'a-hezheng' },
          { id: 'l4', roleId: 'r-zhouye', text: '我回来，不是为了跟你商量。', read: false, currentActorId: 'a-hezheng' },
        ],
        cues: [
          { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', ownerRoleId: 'r-zhoulan', assigneeActorId: 'a-suwan', delivered: false },
          { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', ownerRoleId: 'r-zhouye', assigneeActorId: 'a-hezheng', delivered: true },
        ],
        questions: [
          { id: 'q1', lineId: 'l1', text: '这句是否要背对观众说？', actorId: 'a-suwan', createdAt: now - 3600_000 },
          { id: 'q2', lineId: 'l3', text: '「黑暗」两个字要不要吞音处理？', actorId: 'a-hezheng', createdAt: now - 1800_000 },
        ],
        handovers: [
          {
            id: 'ho-seed-1',
            sessionId: 's3',
            roleId: 'r-zhouye',
            fromActorId: 'a-jinchuan',
            toActorId: 'a-hezheng',
            baseVersion: 1,
            appliedVersion: 2,
            reason: '金川嗓音不适，何铮接替周野。',
            appliedAt: now - 7200_000,
            transferredLineIds: ['l3', 'l4'],
            keptReadLineIds: [],
            transferredCueIds: ['c2'],
          },
        ],
      },
      {
        id: 's4',
        title: '第四场 · 散场之后',
        status: 'ended',
        version: 1,
        roles: [{ roleId: 'r-zhoulan', roleName: '周岚', currentActorId: 'a-suwan' }],
        lines: [
          { id: 'l5', roleId: 'r-zhoulan', text: '人都走光了，你还留在这儿做什么。', read: true, readByActorId: 'a-suwan', currentActorId: 'a-suwan' },
        ],
        cues: [],
        questions: [],
        handovers: [],
      },
    ],
    audit: [
      {
        id: 'au-seed-1',
        at: now - 7200_000,
        windowId: 'win-server',
        sessionId: 's3',
        type: 'handover-applied',
        summary: '角色「周野」金川 → 何铮，场次升至 v2',
        detail: '换角原因：金川嗓音不适，何铮接替周野。\n未读台词转交 2 条；未执行场记提示转交 1 条',
      },
    ],
  };
}
