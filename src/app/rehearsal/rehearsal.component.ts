import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription } from 'rxjs';
import { ConflictDialogComponent } from '../conflict-dialog.component';
import {
  clearRejected,
  endSession,
  loadSessions,
  markLineRead,
  removeFromOutbox,
  retryOutbox,
  setOnline,
  setSimulateFailure,
  submitHandover
} from '../state/rehearsal.actions';
import { HandoverRecord, HandoverRequest, OutboxItem, RehearsalSession, RehearsalState } from '../state/rehearsal.reducer';

@Component({
  selector: 'app-rehearsal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatDialogModule,
    TranslocoModule
  ],
  template: `
    <ng-container *ngIf="session as s">
      <mat-card class="session-card">
        <mat-card-title>
          {{ s.label }}
          <mat-chip [color]="s.status === 'active' ? 'primary' : 'warn'" selected>
            {{ s.status === 'active' ? '进行中' : '已结束' }}
          </mat-chip>
          <mat-chip class="version-chip">场次版本 v{{ s.version }}</mat-chip>
        </mat-card-title>
        <mat-card-subtitle>
          换角按场次版本比对：晚到的请求若基于旧版本，会列出冲突条目且不能覆盖已生效的交接。
        </mat-card-subtitle>

        <div class="toolbar">
          <mat-slide-toggle [checked]="online" (change)="toggleOnline($event.checked)">
            {{ online ? '在线' : '离线（请求留在本机）' }}
          </mat-slide-toggle>
          <mat-slide-toggle [checked]="simulateFailure" (change)="toggleSimulateFailure($event.checked)">
            模拟保存失败（500，用于重试演示）
          </mat-slide-toggle>
          <button mat-stroked-button color="warn" [disabled]="s.status === 'ended'" (click)="endSession()">
            结束场次
          </button>
        </div>
      </mat-card>

      <div class="grid">
        <div class="col">
          <mat-card>
            <mat-card-title>角色与扮演者</mat-card-title>
            <mat-card-content>
              <div class="role-row" *ngFor="let r of s.roles">
                <span class="role-name">{{ r.role }}</span>
                <mat-icon>arrow_forward</mat-icon>
                <span class="actor-name">{{ r.actor }}</span>
              </div>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-title>换人申请</mat-card-title>
            <mat-card-content>
              <form class="handover-form" (ngSubmit)="submit()">
                <mat-form-field appearance="outline">
                  <mat-label>角色</mat-label>
                  <mat-select [(ngModel)]="form.role" name="role" required>
                    <mat-option *ngFor="let r of s.roles" [value]="r.role">{{ r.role }}（{{ r.actor }}）</mat-option>
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>接替演员</mat-label>
                  <input matInput [(ngModel)]="form.toActor" name="toActor" required placeholder="例如：丁柠">
                </mat-form-field>
                <mat-slide-toggle [(ngModel)]="form.late" name="late">模拟晚到（基准版本 -1，必触发冲突）</mat-slide-toggle>
                <button mat-flat-button color="primary" type="submit" [disabled]="s.status === 'ended' || !form.role || !form.toActor">
                  提交换人
                </button>
              </form>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-title>台词归属</mat-card-title>
            <mat-card-content>
              <article class="line" *ngFor="let line of s.lines">
                <div class="line-head">
                  <mat-chip class="role-chip">{{ line.role }}</mat-chip>
                  <span class="line-text">{{ line.text }}</span>
                </div>
                <div class="line-meta">
                  <ng-container *ngIf="line.read; else unread">
                    <mat-chip color="accent" selected>已读 · 记在 {{ line.readBy }} 名下</mat-chip>
                    <span class="note">已读台词不随角色转走</span>
                  </ng-container>
                  <ng-template #unread>
                    <mat-chip>未读 · 归 {{ line.actor }}</mat-chip>
                    <span class="note">未读台词随交接归接替者</span>
                  </ng-template>
                  <button mat-button (click)="toggleRead(line.id, !line.read)">
                    {{ line.read ? '标记未读' : '标记已读' }}
                  </button>
                </div>
              </article>
            </mat-card-content>
          </mat-card>
        </div>

        <div class="col">
          <mat-card>
            <mat-card-title>场记提示</mat-card-title>
            <mat-card-content>
              <article class="line" *ngFor="let cue of s.cues">
                <div class="line-head">
                  <mat-chip class="role-chip">{{ cue.role }}</mat-chip>
                  <span class="line-text">{{ cue.text }}</span>
                </div>
                <div class="line-meta">
                  <mat-chip>归 {{ cue.actor }}</mat-chip>
                  <span class="note">场记提示随交接归接替者</span>
                </div>
              </article>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-title>演员私下疑问</mat-card-title>
            <mat-card-content>
              <article class="line" *ngFor="let q of s.questions">
                <div class="line-head">
                  <mat-chip class="role-chip">{{ q.actor }}</mat-chip>
                  <span class="line-text">{{ q.text }}</span>
                </div>
                <div class="line-meta">
                  <span class="note">私下疑问记在 {{ q.actor }} 名下，不随角色转走</span>
                </div>
              </article>
            </mat-card-content>
          </mat-card>

          <mat-card>
            <mat-card-title>本机队列（断网 / 失败重试）</mat-card-title>
            <mat-card-content>
              <p *ngIf="!outbox.length" class="empty">队列已空。断网时提交的请求会留在这里，恢复网络后按场次版本合并。</p>
              <article class="out-item" *ngFor="let item of outbox">
                <div class="out-head">
                  <mat-chip [color]="outboxColor(item.status)" selected>{{ outboxLabel(item.status) }}</mat-chip>
                  <span class="out-role">{{ item.request.role }}：{{ item.request.fromActor }} → {{ item.request.toActor }}</span>
                </div>
                <p class="out-reason" *ngIf="item.reason">{{ item.reason }}</p>
                <p class="out-reason error" *ngIf="item.lastError">{{ item.lastError }}（第 {{ item.attempts }} 次）</p>
                <div class="out-actions">
                  <button mat-button color="primary" (click)="retry()" [disabled]="!online || item.status === 'rejected'">重试</button>
                  <button mat-button (click)="dismiss(item)">{{ item.status === 'rejected' ? '移除' : '取消' }}</button>
                </div>
              </article>
            </mat-card-content>
          </mat-card>
        </div>
      </div>

      <mat-card class="history-card">
        <mat-card-title>交接与拒绝记录</mat-card-title>
        <mat-card-content>
          <p *ngIf="!history.length" class="empty">暂无记录。</p>
          <article class="hist-item" *ngFor="let h of history">
            <div class="hist-head">
              <mat-chip [color]="h.result === 'accepted' ? 'primary' : 'warn'" selected>
                {{ h.result === 'accepted' ? '已交接' : '已拒绝' }}
              </mat-chip>
              <span class="hist-role">{{ h.role }}：{{ h.fromActor }} → {{ h.toActor }}</span>
              <span class="hist-version" *ngIf="h.version > 0">v{{ h.version }}</span>
              <span class="hist-time">{{ h.at | date:'MM-dd HH:mm:ss' }}</span>
            </div>
            <p class="hist-reason" *ngIf="h.reason">{{ h.reason }}</p>
            <ul class="hist-conflicts" *ngIf="h.conflicts?.length">
              <li *ngFor="let c of h.conflicts">
                v{{ c.version }} · {{ c.role }} · {{ c.from }} → {{ c.to }}
              </li>
            </ul>
          </article>
        </mat-card-content>
      </mat-card>
    </ng-container>
  `,
  styles: [`
    .session-card { margin-bottom: 16px; }
    .session-card mat-card-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .version-chip { background: #eef2ff; color: #3730a3; }
    .toolbar { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; margin-top: 14px; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; }
    .col { display: flex; flex-direction: column; gap: 16px; }
    .role-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid #f1f5f9; }
    .role-name { font-weight: 600; min-width: 64px; }
    .actor-name { color: #15803d; font-weight: 600; }
    .handover-form { display: flex; flex-direction: column; gap: 12px; }
    .line { padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
    .line-head { display: flex; align-items: flex-start; gap: 10px; }
    .role-chip { flex-shrink: 0; }
    .line-text { line-height: 1.6; }
    .line-meta { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
    .note { color: #6b7280; font-size: 12px; }
    .empty { color: #9ca3af; }
    .out-item { padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 10px; }
    .out-head { display: flex; align-items: center; gap: 10px; }
    .out-role { font-weight: 600; }
    .out-reason { color: #b45309; margin: 8px 0 0; font-size: 13px; }
    .out-reason.error { color: #b91c1c; }
    .out-actions { display: flex; gap: 8px; margin-top: 8px; }
    .hist-item { padding: 12px; border-bottom: 1px solid #f1f5f9; }
    .hist-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .hist-role { font-weight: 600; }
    .hist-version { background: #eef2ff; color: #3730a3; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
    .hist-time { color: #9ca3af; font-size: 12px; margin-left: auto; }
    .hist-reason { color: #b45309; margin: 8px 0 0; font-size: 13px; }
    .hist-conflicts { margin: 6px 0 0; padding-left: 20px; color: #6b7280; font-size: 13px; }
    @media (max-width: 820px) { .grid { grid-template-columns: 1fr; } }
  `]
})
export class RehearsalComponent implements OnInit, OnDestroy {
  session: RehearsalSession | null = null;
  outbox: OutboxItem[] = [];
  history: HandoverRecord[] = [];
  online = true;
  simulateFailure = false;

  form = { role: '', toActor: '', late: false };

  private subscription?: Subscription;
  private onlineHandler = () => this.store.dispatch(setOnline({ online: navigator.onLine }));
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ rehearsal: RehearsalState }>, private readonly dialog: MatDialog) {}

  ngOnInit(): void {
    this.store.dispatch(loadSessions());
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.store.select('rehearsal').subscribe((state) => {
      this.session = state.sessions.find((item) => item.id === state.currentSessionId) ?? state.sessions[0] ?? null;
      this.outbox = state.outbox;
      this.history = state.history;
      this.online = state.online;
      this.simulateFailure = state.simulateFailure;
      localStorage.setItem('yf52-rehearsal-outbox', JSON.stringify({
        outbox: state.outbox,
        currentSessionId: state.currentSessionId,
        online: state.online,
        simulateFailure: state.simulateFailure
      }));
      // 冲突弹窗：最新一条被拒记录带 conflicts 时弹出
      const latest = state.history[0];
      if (latest && latest.result === 'rejected' && latest.conflicts?.length && !this.shownConflictIds.has(latest.id)) {
        this.shownConflictIds.add(latest.id);
        this.dialog.open(ConflictDialogComponent, {
          width: '520px',
          data: { reason: latest.reason, conflicts: latest.conflicts }
        });
      }
    });
  }

  private readonly shownConflictIds = new Set<string>();

  ngOnDestroy(): void {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  submit(): void {
    if (!this.session || !this.form.role || !this.form.toActor) return;
    const baseVersion = this.form.late ? Math.max(1, this.session.version - 1) : this.session.version;
    const request: HandoverRequest = {
      id: `r${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      sessionId: this.session.id,
      role: this.form.role,
      fromActor: this.session.roles.find((r) => r.role === this.form.role)?.actor ?? '',
      toActor: this.form.toActor.trim(),
      baseVersion,
      createdAt: Date.now()
    };
    this.store.dispatch(submitHandover({ request }));
    this.form.toActor = '';
    this.form.late = false;
  }

  toggleRead(lineId: string, read: boolean): void {
    if (!this.session) return;
    this.store.dispatch(markLineRead({ sessionId: this.session.id, lineId, read }));
  }

  endSession(): void {
    if (!this.session) return;
    this.store.dispatch(endSession({ sessionId: this.session.id }));
  }

  retry(): void {
    this.store.dispatch(retryOutbox());
  }

  dismiss(item: OutboxItem): void {
    if (item.status === 'rejected') {
      this.store.dispatch(clearRejected({ requestId: item.request.id }));
    } else {
      this.store.dispatch(removeFromOutbox({ requestId: item.request.id }));
    }
  }

  toggleOnline(online: boolean): void {
    this.store.dispatch(setOnline({ online }));
  }

  toggleSimulateFailure(on: boolean): void {
    this.store.dispatch(setSimulateFailure({ on }));
  }

  outboxColor(status: OutboxItem['status']): string | undefined {
    switch (status) {
      case 'queued': return undefined;
      case 'sending': return 'accent';
      case 'failed': return 'warn';
      case 'rejected': return 'warn';
    }
  }

  outboxLabel(status: OutboxItem['status']): string {
    switch (status) {
      case 'queued': return '待提交';
      case 'sending': return '提交中';
      case 'failed': return '保存失败 · 待重试';
      case 'rejected': return '已拒绝';
    }
  }
}
