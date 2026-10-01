import { createReducer, on } from '@ngrx/store';
import * as Actions from './rehearsal.actions';

export type SessionStatus = 'active' | 'ended';
export type OutboxStatus = 'queued' | 'sending' | 'failed' | 'rejected';
export type HandoverResult = 'accepted' | 'rejected';

/** 台词：已读的 credit 记在原演员(readBy)，未读的归当前扮演者(actor) */
export interface SessionLine {
  id: string;
  role: string;
  text: string;
  read: boolean;
  /** 当前扮演者（未读台词归接替者） */
  actor: string;
  /** 已读时记在谁名下（原演员），不随角色转走 */
  readBy?: string;
}

/** 场记提示：归角色的接替者 */
export interface SessionCue {
  id: string;
  scene: string;
  text: string;
  role: string;
  actor: string;
}

/** 演员私下疑问：记在提问演员名下，不随角色转走 */
export interface SessionQuestion {
  id: string;
  role: string;
  actor: string;
  text: string;
}

export interface SessionRole {
  role: string;
  actor: string;
}

export interface RehearsalSession {
  id: string;
  label: string;
  /** 场次版本号：每次生效的交接 +1，用于乐观并发比对 */
  version: number;
  status: SessionStatus;
  roles: SessionRole[];
  lines: SessionLine[];
  cues: SessionCue[];
  questions: SessionQuestion[];
}

/** 冲突条目：晚到提交时，列出在它之前已生效的交接 */
export interface ConflictItem {
  version: number;
  role: string;
  from: string;
  to: string;
  at: number;
}

export interface HandoverRecord {
  id: string;
  requestId: string;
  sessionId: string;
  role: string;
  fromActor: string;
  toActor: string;
  /** 生效时的场次版本；被拒时为当前版本 */
  version: number;
  result: HandoverResult;
  reason?: string;
  conflicts?: ConflictItem[];
  at: number;
}

export interface HandoverRequest {
  id: string;
  sessionId: string;
  role: string;
  fromActor: string;
  toActor: string;
  /** 提交时依据的场次版本 */
  baseVersion: number;
  createdAt: number;
}

export interface OutboxItem {
  request: HandoverRequest;
  status: OutboxStatus;
  reason?: string;
  conflicts?: ConflictItem[];
  lastError?: string;
  attempts: number;
}

export interface RehearsalState {
  sessions: RehearsalSession[];
  currentSessionId: string;
  /** 本机队列：断网提交 / 保存失败保留的请求 */
  outbox: OutboxItem[];
  /** 审计：每次交接与拒绝原因 */
  history: HandoverRecord[];
  online: boolean;
  syncing: boolean;
  simulateFailure: boolean;
  loaded: boolean;
}

export function initialSession(): RehearsalSession {
  return {
    id: 's1',
    label: '第三场排练 · 角色交接',
    version: 1,
    status: 'active',
    roles: [
      { role: '周岚', actor: '苏晴' },
      { role: '周野', actor: '陆川' }
    ],
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', read: true, actor: '苏晴', readBy: '苏晴' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', read: false, actor: '陆川' },
      { id: 'l3', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', read: false, actor: '苏晴' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', role: '周岚', actor: '苏晴' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', role: '周野', actor: '陆川' }
    ],
    questions: [
      { id: 'q1', role: '周岚', actor: '苏晴', text: '这句的情绪是收着还是放出来？' }
    ]
  };
}

const OUTBOX_KEY = 'yf52-rehearsal-outbox';

function getInitialState(): RehearsalState {
  const base: RehearsalState = {
    sessions: [],
    currentSessionId: 's1',
    outbox: [],
    history: [],
    online: true,
    syncing: false,
    simulateFailure: false,
    loaded: false
  };
  if (typeof localStorage === 'undefined') return base;
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<RehearsalState>;
      return {
        ...base,
        currentSessionId: saved.currentSessionId ?? 's1',
        outbox: saved.outbox ?? [],
        online: saved.online ?? true,
        simulateFailure: saved.simulateFailure ?? false
      };
    }
  } catch { /* 忽略损坏的本地缓存 */ }
  return base;
}

export const rehearsalReducer = createReducer(
  getInitialState(),
  on(Actions.loadSessionsSuccess, (state, { sessions }) => ({ ...state, sessions, loaded: true })),
  on(Actions.loadHistorySuccess, (state, { history }) => ({ ...state, history })),

  on(Actions.submitHandoverQueued, (state, { item }) => ({ ...state, outbox: [...state.outbox, item] })),

  on(Actions.submitHandoverSuccess, (state, { requestId, record, session }) => ({
    ...state,
    sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
    history: [record, ...state.history],
    outbox: state.outbox.filter((i) => i.request.id !== requestId),
    syncing: false
  })),

  on(Actions.submitHandoverRejected, (state, { requestId, record, reason, conflicts }) => ({
    ...state,
    history: [record, ...state.history],
    outbox: state.outbox.map((i) =>
      i.request.id === requestId ? { ...i, status: 'rejected' as OutboxStatus, reason, conflicts } : i
    ),
    syncing: false
  })),

  on(Actions.submitHandoverFailed, (state, { request, error }) => {
    const exists = state.outbox.some((i) => i.request.id === request.id);
    const outbox = exists
      ? state.outbox.map((i) =>
          i.request.id === request.id
            ? { ...i, status: 'failed' as OutboxStatus, lastError: error, attempts: i.attempts + 1 }
            : i
        )
      : [...state.outbox, { request, status: 'failed' as OutboxStatus, lastError: error, attempts: 1 }];
    return { ...state, outbox, syncing: false };
  }),

  on(Actions.processOutbox, Actions.retryOutbox, (state) => ({ ...state, syncing: true })),

  on(Actions.setOnline, (state, { online }) => ({ ...state, online })),
  on(Actions.setSimulateFailure, (state, { on }) => ({ ...state, simulateFailure: on })),

  on(Actions.endSessionSuccess, (state, { session }) => ({
    ...state,
    sessions: state.sessions.map((s) => (s.id === session.id ? session : s))
  })),
  on(Actions.markLineReadSuccess, (state, { session }) => ({
    ...state,
    sessions: state.sessions.map((s) => (s.id === session.id ? session : s))
  })),

  on(Actions.removeFromOutbox, (state, { requestId }) => ({
    ...state,
    outbox: state.outbox.filter((i) => i.request.id !== requestId)
  })),
  on(Actions.clearRejected, (state, { requestId }) => ({
    ...state,
    outbox: state.outbox.filter((i) => i.request.id !== requestId)
  }))
);
