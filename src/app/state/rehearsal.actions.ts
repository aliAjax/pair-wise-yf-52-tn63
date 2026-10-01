import { createAction, props } from '@ngrx/store';
import { ConflictItem, HandoverRecord, HandoverRequest, OutboxItem, RehearsalSession } from './rehearsal.reducer';

// 场次加载
export const loadSessions = createAction('[Rehearsal] Load Sessions');
export const loadHistory = createAction('[Rehearsal] Load History');
export const loadSessionsSuccess = createAction('[Rehearsal] Load Sessions Success', props<{ sessions: RehearsalSession[] }>());
export const loadHistorySuccess = createAction('[Rehearsal] Load History Success', props<{ history: HandoverRecord[] }>());
export const serverUpdated = createAction('[Rehearsal] Server Updated');

// 换人请求
export const submitHandover = createAction('[Rehearsal] Submit Handover', props<{ request: HandoverRequest }>());
export const submitHandoverQueued = createAction('[Rehearsal] Submit Handover Queued', props<{ item: OutboxItem }>());
export const submitHandoverSuccess = createAction(
  '[Rehearsal] Submit Handover Success',
  props<{ requestId: string; record: HandoverRecord; session: RehearsalSession }>()
);
export const submitHandoverRejected = createAction(
  '[Rehearsal] Submit Handover Rejected',
  props<{ requestId: string; record: HandoverRecord; reason: string; conflicts?: ConflictItem[] }>()
);
export const submitHandoverFailed = createAction(
  '[Rehearsal] Submit Handover Failed',
  props<{ request: HandoverRequest; error: string }>()
);

// 本机队列
export const processOutbox = createAction('[Rehearsal] Process Outbox');
export const retryOutbox = createAction('[Rehearsal] Retry Outbox');
export const removeFromOutbox = createAction('[Rehearsal] Remove From Outbox', props<{ requestId: string }>());
export const clearRejected = createAction('[Rehearsal] Clear Rejected', props<{ requestId: string }>());

// 场次操作
export const endSession = createAction('[Rehearsal] End Session', props<{ sessionId: string }>());
export const endSessionSuccess = createAction('[Rehearsal] End Session Success', props<{ session: RehearsalSession }>());
export const endSessionFailed = createAction('[Rehearsal] End Session Failed', props<{ error: string }>());

export const markLineRead = createAction('[Rehearsal] Mark Line Read', props<{ sessionId: string; lineId: string; read: boolean }>());
export const markLineReadSuccess = createAction('[Rehearsal] Mark Line Read Success', props<{ session: RehearsalSession }>());
export const markLineReadFailed = createAction('[Rehearsal] Mark Line Read Failed', props<{ error: string }>());

// 设置
export const setOnline = createAction('[Rehearsal] Set Online', props<{ online: boolean }>());
export const setSimulateFailure = createAction('[Rehearsal] Set Simulate Failure', props<{ on: boolean }>());
