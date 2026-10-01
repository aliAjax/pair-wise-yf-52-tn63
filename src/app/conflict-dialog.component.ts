import { CommonModule } from '@angular/common';
import { Component, Inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { ConflictItem } from './state/rehearsal.reducer';

export interface ConflictDialogData {
  reason: string;
  conflicts: ConflictItem[];
}

@Component({
  selector: 'app-conflict-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title><mat-icon color="warn">warning</mat-icon> 换人请求被拒绝</h2>
    <mat-dialog-content>
      <p class="reason">{{ data.reason }}</p>
      <p class="hint">以下交接已在你提交之前生效，不能被覆盖：</p>
      <ul class="conflict-list">
        <li *ngFor="let item of data.conflicts">
          <span class="version">v{{ item.version }}</span>
          <span class="role">{{ item.role }}</span>
          <span class="arrow">{{ item.from }} → {{ item.to }}</span>
        </li>
      </ul>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-flat-button color="primary" mat-dialog-close>知道了</button>
    </mat-dialog-actions>
  `,
  styles: [`
    h2 { display: flex; align-items: center; gap: 8px; }
    .reason { font-weight: 600; color: #b45309; margin: 0 0 8px; }
    .hint { color: #6b7280; margin: 0 0 12px; }
    .conflict-list { list-style: none; padding: 0; margin: 0; }
    .conflict-list li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    .version { background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 6px; font-size: 12px; }
    .role { font-weight: 600; }
    .arrow { color: #374151; }
  `]
})
export class ConflictDialogComponent {
  constructor(@Inject(MAT_DIALOG_DATA) public data: ConflictDialogData) {}
}
