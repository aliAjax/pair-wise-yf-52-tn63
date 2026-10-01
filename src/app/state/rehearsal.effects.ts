import { Injectable } from '@angular/core';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { EMPTY, from, merge, timer } from 'rxjs';
import { concatMap, filter, map, mergeMap, withLatestFrom } from 'rxjs/operators';
import { RehearsalServer } from '../rehearsal.service';
import * as R from './rehearsal.actions';
import { OutboxItem, RehearsalState } from './rehearsal.reducer';

@Injectable()
export class RehearsalEffects {
  constructor(
    private readonly actions$: Actions,
    private readonly server: RehearsalServer,
    private readonly store: Store<{ rehearsal: RehearsalState }>
  ) {}

  load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.loadSessions),
      mergeMap(() =>
        this.server.sessions().pipe(map((sessions) => R.loadSessionsSuccess({ sessions })))
      )
    )
  );

  loadHistory$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.loadSessions, R.loadHistory),
      mergeMap(() =>
        this.server.history().pipe(map((history) => R.loadHistorySuccess({ history })))
      )
    )
  );

  /** 在线提交：直接送服务器 */
  submitOnline$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.submitHandover),
      withLatestFrom(this.store.select('rehearsal')),
      filter(([, state]) => state.online),
      concatMap(([action]) =>
        this.server.submitHandover(action.request).pipe(
          map((result) => {
            switch (result.type) {
              case 'accepted':
                return R.submitHandoverSuccess({ requestId: action.request.id, record: result.record, session: result.session });
              case 'rejected':
                return R.submitHandoverRejected({
                  requestId: action.request.id,
                  record: result.record,
                  reason: result.reason,
                  conflicts: result.conflicts
                });
              case 'failed':
                return R.submitHandoverFailed({ request: action.request, error: result.error });
            }
          })
        )
      )
    )
  );

  /** 断网提交：进入本机队列，留在本机 */
  submitOffline$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.submitHandover),
      withLatestFrom(this.store.select('rehearsal')),
      filter(([, state]) => !state.online),
      map(([action]) =>
        R.submitHandoverQueued({ item: { request: action.request, status: 'queued', attempts: 0 } as OutboxItem })
      )
    )
  );

  /** 网络恢复 → 触发队列合并 */
  syncOnReconnect$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.setOnline),
      filter(({ online }) => online),
      map(() => R.processOutbox())
    )
  );

  /** 处理本机队列：逐条按场次版本合并；失败保留，等待下次重试 */
  processOutbox$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.processOutbox, R.retryOutbox),
      withLatestFrom(this.store.select('rehearsal')),
      filter(([, state]) => state.online),
      mergeMap(([, state]) => {
        const items = state.outbox.filter((item) => item.status === 'queued' || item.status === 'failed');
        if (!items.length) return EMPTY;
        return from(items).pipe(
          concatMap((item) =>
            this.server.submitHandover(item.request).pipe(map((result) => ({ item, result })))
          ),
          map(({ item, result }) => {
            switch (result.type) {
              case 'accepted':
                return R.submitHandoverSuccess({ requestId: item.request.id, record: result.record, session: result.session });
              case 'rejected':
                return R.submitHandoverRejected({
                  requestId: item.request.id,
                  record: result.record,
                  reason: result.reason,
                  conflicts: result.conflicts
                });
              case 'failed':
                return R.submitHandoverFailed({ request: item.request, error: result.error });
            }
          })
        );
      })
    )
  );

  /** 在线时定时重试失败项（保存失败后继续保留并重试） */
  autoRetry$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.loadSessions),
      mergeMap(() =>
        timer(15000, 15000).pipe(
          withLatestFrom(this.store.select('rehearsal')),
          filter(([, state]) => state.online && state.outbox.some((item) => item.status === 'failed')),
          map(() => R.processOutbox())
        )
      )
    )
  );

  /** 交接成功后刷新审计历史 */
  refreshHistory$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.submitHandoverSuccess),
      mergeMap(() =>
        this.server.history().pipe(map((history) => R.loadHistorySuccess({ history })))
      )
    )
  );

  /** 其他窗口改动服务器 → 刷新场次与历史 */
  serverUpdates$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.loadSessions),
      mergeMap(() => this.server.serverUpdates().pipe(map(() => R.serverUpdated())))
    )
  );

  serverUpdated$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.serverUpdated),
      mergeMap(() =>
        merge(
          this.server.sessions().pipe(map((sessions) => R.loadSessionsSuccess({ sessions }))),
          this.server.history().pipe(map((history) => R.loadHistorySuccess({ history })))
        )
      )
    )
  );

  endSession$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.endSession),
      concatMap(({ sessionId }) =>
        this.server.endSession(sessionId).pipe(
          map((session) =>
            session ? R.endSessionSuccess({ session }) : R.endSessionFailed({ error: '场次不存在' })
          )
        )
      )
    )
  );

  markLineRead$ = createEffect(() =>
    this.actions$.pipe(
      ofType(R.markLineRead),
      concatMap(({ sessionId, lineId, read }) =>
        this.server.markLineRead(sessionId, lineId, read).pipe(
          map((session) =>
            session ? R.markLineReadSuccess({ session }) : R.markLineReadFailed({ error: '场次不存在' })
          )
        )
      )
    )
  );
}
