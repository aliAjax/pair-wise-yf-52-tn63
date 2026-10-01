import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { combineLatest, map } from 'rxjs';
import { HandoverStore } from './state/handover.store';
import {
  Actor,
  AuditEntry,
  HandoverResult,
  PendingHandover,
  RehearsalSession,
  ScriptLine,
  StageCue,
} from './state/handover.model';

interface ResultView {
  kind: 'applied' | 'conflict' | 'rejected' | 'queued';
  title: string;
  body: string;
  result?: HandoverResult;
  queuedReason?: 'offline' | 'save-failed';
  at: number;
}

interface AuditRow extends AuditEntry {
  source: 'server' | 'local';
}

@Component({
  selector: 'app-handover-panel',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatChipsModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
  ],
  template: `
    <mat-card class="panel">
      <mat-card-title>场次角色交接（版本化换人）</mat-card-title>
      <mat-card-subtitle>
        本窗口：<b>{{ store.windowId }}</b>
        · 状态：
        <button mat-stroked-button [color]="(store.online$ | async) ? 'primary' : 'warn'" (click)="toggleOnline()">
          {{ (store.online$ | async) ? '在线' : '断网（本机缓存）' }}
        </button>
        <button mat-stroked-button class="tool" (click)="store.armSaveFailures(1)">模拟下一次服务器保存失败</button>
        <button mat-stroked-button class="tool" color="warn" (click)="endSession()" [disabled]="!(activeSession$ | async) || (activeSession$ | async)?.status === 'ended'">
          结束当前场次
        </button>
      </mat-card-subtitle>

      <div class="chips">
        <button
          mat-stroked-button
          *ngFor="let s of (store.server$ | async)?.sessions"
          [color]="s.id === selectedSessionId ? 'primary' : ''"
          (click)="selectSession(s.id)"
        >
          {{ s.title }} · v{{ s.version }} · {{ s.status === 'ended' ? '已结束' : '排练中' }}
        </button>
      </div>

      <p class="tip">
        换人规则：已读台词固定记在读它的演员名下；未读台词与未执行的场记提示归接替者；演员私下写的疑问只属于本人，不随角色转走。
        并发送招：请再开一个浏览器标签页（窗口名不同）同时打开本页，两窗口对同一角色换人，晚到提交会先比对场次版本并列出冲突条目，不会盖掉已生效交接。
      </p>
    </mat-card>

    <ng-container *ngIf="activeSession$ | async as session">
      <!-- 提交结果 -->
      <mat-card class="banner ok" *ngIf="lastResult?.kind === 'applied'">
        <b>✓ {{ lastResult.title }}</b>
        <pre>{{ lastResult.body }}</pre>
      </mat-card>
      <mat-card class="banner conflict" *ngIf="lastResult?.kind === 'conflict'">
        <b>⚠ {{ lastResult.title }}</b>
        <p>{{ lastResult.body }}</p>
        <ul>
          <li *ngFor="let item of lastResult.result?.conflicts">
            <b>{{ item.label }}</b>：{{ item.detail }}
          </li>
        </ul>
        <p class="muted">已生效的交接保持不变；如需继续换人，请以当前 v{{ lastResult.result?.currentVersion }} 为基准重新提交。</p>
      </mat-card>
      <mat-card class="banner reject" *ngIf="lastResult?.kind === 'rejected'">
        <b>✕ {{ lastResult.title }}</b>
        <p>{{ lastResult.result?.rejectReason }}</p>
      </mat-card>
      <mat-card class="banner queued" *ngIf="lastResult?.kind === 'queued'">
        <b>◷ {{ lastResult.title }}</b>
        <p>{{ lastResult.body }}</p>
      </mat-card>

      <section class="role-grid">
        <mat-card *ngFor="let role of session.roles" class="role-card">
          <mat-card-title>
            {{ role.roleName }}
            <span class="actor">{{ actorName(role.currentActorId) }}</span>
          </mat-card-title>
          <mat-card-subtitle>
            {{ session.status === 'ended' ? '场次已结束，不可换人' : '当前扮演者' }}
          </mat-card-subtitle>

          <div class="block">
            <h4>台词归属</h4>
            <article class="entry" *ngFor="let line of linesOf(role.roleId, session)">
              <div>
                <span class="tag" [class.read]="line.read">{{ line.read ? '已读 · 保留' : '未读 · 随角色转交' }}</span>
                <p>{{ line.text }}</p>
                <small>记在：<b>{{ actorName(line.currentActorId) }}</b><ng-container *ngIf="line.read">（读它的人：{{ actorName(line.readByActorId!) }}）</ng-container></small>
              </div>
            </article>
          </div>

          <div class="block">
            <h4>场记提示归属</h4>
            <article class="entry" *ngFor="let cue of cuesOf(role.roleId, session)">
              <span class="tag" [class.read]="cue.delivered">{{ cue.delivered ? '已执行 · 保留' : '未执行 · 随角色转交' }}</span>
              <p>{{ cue.scene }}：{{ cue.text }}</p>
              <small>执行人：<b>{{ actorName(cue.assigneeActorId) }}</b></small>
            </article>
            <p *ngIf="cuesOf(role.roleId, session).length === 0" class="muted">该角色暂无场记提示。</p>
          </div>

          <div class="block">
            <h4>演员私有疑问 <span class="muted">（换人不转走）</span></h4>
            <article class="entry q" *ngFor="let q of questionsOf(role.currentActorId, session)">
              <p>{{ q.text }}</p>
              <small>写于：<b>{{ actorName(q.actorId) }}</b> 本人 · {{ fmt(q.createdAt) }}</small>
            </article>
            <p *ngIf="questionsOf(role.currentActorId, session).length === 0" class="muted">当前扮演者没有留下疑问。</p>
          </div>

          <button
            mat-flat-button
            color="primary"
            *ngIf="session.status === 'rehearsing'"
            (click)="openForm(role.roleId, role.currentActorId, session.version)"
          >
            口头换人：为「{{ role.roleName }}」安排接替者
          </button>
        </mat-card>
      </section>

      <!-- 换人表单：打开时锁定基准版本，模拟两个窗口同时提交 -->
      <mat-card class="form-card" *ngIf="formRoleId">
        <mat-card-title>换人申请 · {{ formRoleName(session) }}</mat-card-title>
        <mat-card-subtitle>
          原演员：<b>{{ actorName(formFromActorId!) }}</b>
          ｜提交基准：场次 <b>v{{ formBaseVersion }}</b>（当前服务器 v{{ session.version }}）
          <span class="warn" *ngIf="staleSameRole(session)">— 该角色在此期间已被换人，直接提交将得到版本冲突列表，不会覆盖</span>
          <span class="muted" *ngIf="formBaseVersion !== session.version && !staleSameRole(session)">— 期间只有其他角色交接，提交将在当前版本上合并</span>
        </mat-card-subtitle>

        <mat-form-field appearance="outline">
          <mat-label>接替者</mat-label>
          <mat-select [(ngModel)]="formToActorId">
            <mat-option *ngFor="let a of candidateActors(session)" [value]="a.id">{{ a.name }}</mat-option>
          </mat-select>
        </mat-form-field>

        <mat-form-field appearance="outline" class="reason">
          <mat-label>换角原因（口头说明，记入交接审计）</mat-label>
          <textarea matInput rows="2" [(ngModel)]="formReason" placeholder="例如：突发请假，由替角接替"></textarea>
        </mat-form-field>

        <div class="actions">
          <button mat-flat-button color="primary" (click)="submitForm()" [disabled]="!formToActorId">提交换人</button>
          <button mat-button (click)="cancelForm()">取消</button>
        </div>
      </mat-card>

      <!-- 本机待发队列 -->
      <mat-card class="queue-card" *ngIf="(store.queue$ | async) as queue">
        <mat-card-title>本机待发换人请求（{{ queue.length }}）</mat-card-title>
        <mat-card-subtitle *ngIf="queue.length > 0">
          断网或保存失败的请求只留在本窗口（windowId：{{ store.windowId }}）；网络恢复后按场次版本合并，保存失败继续保留并重试。
        </mat-card-subtitle>
        <article class="entry" *ngFor="let item of queue">
          <div>
            <p><b>{{ roleNameOf(session, item) }}</b>：{{ actorName(item.fromActorId) }} → {{ actorName(item.toActorId) }}</p>
            <small>
              基准 v{{ item.baseVersion }} · {{ fmt(item.createdAt) }} · 已重试 {{ item.attempts }} 次
              <span class="warn" *ngIf="item.lastError">｜{{ item.lastError }}</span>
            </small>
            <p class="muted" *ngIf="item.reason">原因：{{ item.reason }}</p>
          </div>
          <button mat-stroked-button color="primary" (click)="retryNow()">立即合并重试</button>
        </article>
        <p *ngIf="queue.length === 0" class="muted">本机没有待发请求。</p>
      </mat-card>

      <!-- 交接历史与审计 -->
      <section class="history-grid">
        <mat-card>
          <mat-card-title>本场次交接记录</mat-card-title>
          <article class="entry" *ngFor="let h of session.handovers; let i = index">
            <p>
              <b>#{{ session.handovers.length - i }} v{{ h.appliedVersion }}</b>
              「{{ roleNameById(session, h.roleId) }}」{{ actorName(h.fromActorId) }} → {{ actorName(h.toActorId) }}
            </p>
            <small>{{ fmt(h.appliedAt) }} ｜原演员保留已读 {{ h.keptReadLineIds.length }} 条；接替未读台词 {{ h.transferredLineIds.length }} 条、未执行提示 {{ h.transferredCueIds.length }} 条</small>
            <p class="muted" *ngIf="h.reason">原因：{{ h.reason }}</p>
          </article>
          <p *ngIf="session.handovers.length === 0" class="muted">暂无交接。</p>
        </mat-card>

        <mat-card>
          <mat-card-title>审计：每次交接 / 拒绝原因</mat-card-title>
          <article class="entry audit" *ngFor="let row of auditRows$ | async">
            <span class="tag" [ngClass]="auditClass(row.type)">{{ auditLabel(row.type) }}</span>
            <small class="src">{{ row.source === 'server' ? '共享记录' : '本窗口' }} · {{ row.windowId }} · {{ fmt(row.at) }}</small>
            <p>{{ row.summary }}</p>
            <pre *ngIf="row.detail">{{ row.detail }}</pre>
          </article>
        </mat-card>
      </section>
    </ng-container>
  `,
  styles: [`
    .panel, .banner, .role-card, .form-card, .queue-card, .history-grid mat-card { margin-bottom: 16px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .tool { margin-left: 10px; }
    .tip { background: #f3f4f6; border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.7; margin-top: 14px; }
    .role-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .actor { color: #1d4ed8; font-size: 15px; margin-left: 8px; }
    .block { margin: 14px 0; }
    .block h4 { margin: 0 0 6px; font-size: 14px; }
    .entry { padding: 10px 0; border-bottom: 1px dashed #e5e7eb; display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
    .entry:last-child { border-bottom: none; }
    .entry p { margin: 4px 0; line-height: 1.6; }
    .entry.q { display: block; }
    .tag { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; }
    .tag.read { background: #dcfce7; color: #166534; }
    .muted { color: #6b7280; font-size: 12px; }
    .warn { color: #b45309; }
    .banner { border-left: 6px solid; }
    .banner pre, .audit pre { white-space: pre-wrap; margin: 6px 0 0; font-family: inherit; font-size: 13px; background: #f9fafb; padding: 8px; border-radius: 6px; }
    .banner.ok { border-color: #16a34a; background: #f0fdf4; }
    .banner.conflict { border-color: #d97706; background: #fffbeb; }
    .banner.reject { border-color: #dc2626; background: #fef2f2; }
    .banner.queued { border-color: #2563eb; background: #eff6ff; }
    .banner ul { margin: 8px 0; padding-left: 20px; }
    mat-form-field { width: 100%; }
    .actions { display: flex; gap: 10px; }
    .history-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .audit { display: block; }
    .audit .src { display: block; margin: 4px 0; }
    @media (max-width: 860px) { .history-grid { grid-template-columns: 1fr; } }
  `],
})
export class HandoverPanelComponent {
  selectedSessionId = 's3';

  formRoleId: string | null = null;
  formFromActorId: string | null = null;
  formBaseVersion = 0;
  formToActorId: string | null = null;
  formReason = '';

  lastResult: ResultView | null = null;

  readonly activeSession$ = combineLatest([this.store.server$, this.store.online$]).pipe(
    map(([server]) => server.sessions.find((s) => s.id === this.selectedSessionId) ?? server.sessions[0]),
  );

  readonly auditRows$ = combineLatest([this.store.server$, this.store.localAudit$]).pipe(
    map(([server, local]) => {
      const rows: AuditRow[] = [
        ...server.audit.map((a) => ({ ...a, source: 'server' as const })),
        ...local.map((a) => ({ ...a, source: 'local' as const })),
      ];
      // 合并条目去重：本窗口合并成功的本地审计与服务器审计同文案同时间视为一条。
      const seen = new Set<string>();
      return rows
        .sort((a, b) => b.at - a.at)
        .filter((row) => {
          const key = `${row.at}-${row.summary}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }),
  );

  constructor(readonly store: HandoverStore) {}

  selectSession(id: string): void {
    this.selectedSessionId = id;
    this.cancelForm();
  }

  actorName(actorId: string): string {
    return this.store.server.actors.find((a) => a.id === actorId)?.name ?? actorId;
  }

  linesOf(roleId: string, session: RehearsalSession): ScriptLine[] {
    return session.lines.filter((l) => l.roleId === roleId);
  }

  cuesOf(roleId: string, session: RehearsalSession): StageCue[] {
    return session.cues.filter((c) => c.ownerRoleId === roleId);
  }

  questionsOf(actorId: string, session: RehearsalSession) {
    return session.questions.filter((q) => q.actorId === actorId);
  }

  candidateActors(session: RehearsalSession): Actor[] {
    const role = session.roles.find((r) => r.roleId === this.formRoleId);
    return this.store.server.actors.filter((a) => a.id !== role?.currentActorId);
  }

  formRoleName(session: RehearsalSession): string {
    return session.roles.find((r) => r.roleId === this.formRoleId)?.roleName ?? this.formRoleId ?? '';
  }

  /** 基准版本之后同一角色是否已发生交接（决定晚到提交是否冲突）。 */
  staleSameRole(session: RehearsalSession): boolean {
    if (this.formBaseVersion === session.version || !this.formRoleId) return false;
    return session.handovers.some((h) => h.appliedVersion > this.formBaseVersion && h.roleId === this.formRoleId);
  }

  roleNameById(session: RehearsalSession, roleId: string): string {
    return session.roles.find((r) => r.roleId === roleId)?.roleName ?? roleId;
  }

  roleNameOf(session: RehearsalSession, item: PendingHandover): string {
    return this.roleNameById(session, item.roleId);
  }

  openForm(roleId: string, fromActorId: string, version: number): void {
    // 锁定打开表单瞬间的场次版本：另一窗口先行交接后，这里就是"晚到提交"。
    this.formRoleId = roleId;
    this.formFromActorId = fromActorId;
    this.formBaseVersion = version;
    this.formToActorId = null;
    this.formReason = '';
  }

  cancelForm(): void {
    this.formRoleId = null;
    this.formFromActorId = null;
    this.formToActorId = null;
    this.formReason = '';
  }

  submitForm(): void {
    if (!this.formRoleId || !this.formFromActorId || !this.formToActorId) return;
    const response = this.store.submit({
      sessionId: this.selectedSessionId,
      roleId: this.formRoleId,
      fromActorId: this.formFromActorId,
      toActorId: this.formToActorId,
      reason: this.formReason.trim(),
      baseVersion: this.formBaseVersion,
    });
    this.renderResponse(response);
    this.cancelForm();
  }

  private renderResponse(response: ReturnType<HandoverStore['submit']>): void {
    if (response.queued) {
      this.lastResult = {
        kind: 'queued',
        title: response.queuedReason === 'offline' ? '请求已留在本机（断网）' : '服务器保存失败，请求保留并重试',
        body:
          response.queuedReason === 'offline'
            ? '网络恢复后将按场次版本自动合并；若期间已有交接生效，会列出冲突条目而不是覆盖。'
            : '本窗口会自动重试，也可以在下方"本机待发"中立即合并。',
        queuedReason: response.queuedReason,
        at: Date.now(),
      };
      return;
    }
    const r = response.immediate!;
    if (r.status === 'applied' && r.handover) {
      this.lastResult = {
        kind: 'applied',
        title: `换人已生效：${this.actorName(r.fromActorId)} → ${this.actorName(r.toActorId)}，场次升至 v${r.currentVersion}`,
        body:
          `已读台词保留 ${r.handover.keptReadLineIds.length} 条，仍记 ${this.actorName(r.fromActorId)} 名下；\n` +
          `未读台词 ${r.handover.transferredLineIds.length} 条、未执行场记提示 ${r.handover.transferredCueIds.length} 条已转给 ${this.actorName(r.toActorId)}；\n` +
          `演员私有疑问未随角色转移。`,
        result: r,
        at: Date.now(),
      };
    } else if (r.status === 'conflict') {
      this.lastResult = {
        kind: 'conflict',
        title: `换人请求版本冲突（基于 v${r.baseVersion}，当前 v${r.currentVersion}），未覆盖任何已生效交接`,
        body: '晚到提交与下列已生效内容冲突：',
        result: r,
        at: Date.now(),
      };
    } else {
      this.lastResult = {
        kind: 'rejected',
        title: '换人请求被拒绝',
        body: r.rejectReason ?? '',
        result: r,
        at: Date.now(),
      };
    }
  }

  retryNow(): void {
    const { processed, remaining } = this.store.flushQueue();
    if (processed === 0 && remaining > 0) {
      this.lastResult = {
        kind: 'queued',
        title: '仍无法保存',
        body: '服务器保存依旧失败（或网络仍断开），请求继续保留在本机，稍后自动重试。',
        at: Date.now(),
      };
    }
  }

  toggleOnline(): void {
    this.store.setOnline(!this.store.online);
  }

  endSession(): void {
    const ok = this.store.endSession(this.selectedSessionId);
    if (ok) this.cancelForm();
  }

  fmt(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  }

  auditLabel(type: AuditEntry['type']): string {
    return {
      'handover-applied': '交接生效',
      'handover-conflict': '版本冲突',
      'handover-rejected': '拒绝',
      'session-ended': '场次结束',
      'queue-kept': '本机留存',
      'save-failed': '保存失败',
    }[type];
  }

  auditClass(type: AuditEntry['type']): string {
    return {
      'handover-applied': 'read',
      'handover-conflict': '',
      'handover-rejected': '',
      'session-ended': 'read',
      'queue-kept': '',
      'save-failed': '',
    }[type];
  }
}
