/**
 * 角色交接纯函数：无副作用，便于单测与复用。
 */
import {
  Actor,
  ConflictItem,
  Handover,
  HandoverResult,
  HandoverServerState,
  PendingHandover,
  RehearsalSession,
  ScriptLine,
  StageCue,
} from './handover.model';

let seq = 0;
export function uid(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${seq}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function actorName(state: HandoverServerState, actorId: string): string {
  return state.actors.find((a) => a.id === actorId)?.name ?? actorId;
}

export function roleName(session: RehearsalSession, roleId: string): string {
  return session.roles.find((r) => r.roleId === roleId)?.roleName ?? roleId;
}

export interface SubmitInput {
  state: HandoverServerState;
  sessionId: string;
  roleId: string;
  fromActorId: string;
  toActorId: string;
  reason: string;
  /** 提交方打开表单时看到的场次版本。 */
  baseVersion: number;
  windowId: string;
  at: number;
}

/**
 * 尝试把一条换人请求应用到服务器状态，返回新状态与结果。
 * 不修改入参。规则顺序：场次存在 → 场次未结束 → 角色与双方演员合法 →
 * 版本一致 → 源演员仍是当前扮演者，全部通过才生效。
 */
export function applyHandover(input: SubmitInput): { state: HandoverServerState; result: HandoverResult } {
  const { state, sessionId, roleId, fromActorId, toActorId, reason, baseVersion, windowId, at } = input;

  const fail = (
    status: 'conflict' | 'rejected',
    rejectReason: string | undefined,
    conflicts: ConflictItem[],
    currentVersion: number,
    base: HandoverServerState,
  ): { state: HandoverServerState; result: HandoverResult } => {
    const session = base.sessions.find((s) => s.id === sessionId);
    const result: HandoverResult = {
      status,
      sessionId,
      roleId,
      fromActorId,
      toActorId,
      reason,
      baseVersion,
      currentVersion,
      conflicts,
      rejectReason,
      audit: {
        id: uid('au'),
        at,
        windowId,
        sessionId,
        type: status === 'conflict' ? 'handover-conflict' : 'handover-rejected',
        summary:
          status === 'conflict'
            ? `角色「${session ? roleName(session, roleId) : roleId}」换人请求存在版本冲突，未生效`
            : `角色「${session ? roleName(session, roleId) : roleId}」换人请求被拒绝：${rejectReason}`,
        detail:
          conflicts.length > 0
            ? conflicts.map((c) => `· ${c.label}：${c.detail}`).join('\n')
            : rejectReason,
      },
    };
    // 冲突与拒绝同样写入服务器审计，之后可查到每次请求的结果与原因。
    return { state: { ...base, audit: [result.audit, ...base.audit] }, result };
  };

  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) {
    return fail('rejected', `场次 ${sessionId} 不存在，请求无法生效`, [], baseVersion, state);
  }

  // 场次已结束：给出明确结果（拒绝），审计里查得到原因。
  if (session.status === 'ended') {
    return fail(
      'rejected',
      `场次「${session.title}」已结束（结束于版本 v${session.version}），不再接受换人`,
      [],
      session.version,
      state,
    );
  }

  const role = session.roles.find((r) => r.roleId === roleId);
  if (!role) {
    return fail('rejected', `角色 ${roleId} 不在本场次中`, [], session.version, state);
  }
  const toActor = state.actors.find((a) => a.id === toActorId);
  if (!toActor) {
    return fail('rejected', `接替者 ${toActorId} 不存在`, [], session.version, state);
  }
  if (role.currentActorId === toActorId) {
    return fail('rejected', `角色「${role.roleName}」已由 ${toActor.name} 担任，无需换人`, [], session.version, state);
  }

  // 晚到提交：先比对版本。只有基准版本之后"同一角色"已被交接才判冲突；
  // 若版本前进仅由其他角色的交接造成，则在当前版本上重放本次换人（rebase）。
  if (baseVersion !== session.version) {
    const newerForRole = session.handovers.filter((h) => h.appliedVersion > baseVersion && h.roleId === roleId);
    if (newerForRole.length > 0) {
      const conflicts = buildVersionConflicts(session, roleId, baseVersion);
      return fail('conflict', undefined, conflicts, session.version, state);
    }
  }

  if (role.currentActorId !== fromActorId) {
    // 同一版本下源演员也已不符（例如角色被转给第三人后又转回），单列为冲突。
    const current = actorName(state, role.currentActorId);
    const conflicts: ConflictItem[] = [
      {
        id: 'role-current-actor',
        label: `角色「${role.roleName}」当前扮演者`,
        detail: `请求记的是 ${actorName(state, fromActorId)}，当前为 ${current}`,
      },
    ];
    return fail('conflict', undefined, conflicts, session.version, state);
  }

  // 执行交接：已读台词保留在原演员名下，未读台词与未执行场记提示归接替者。
  const transferredLineIds: string[] = [];
  const keptReadLineIds: string[] = [];
  const lines: ScriptLine[] = session.lines.map((line) => {
    if (line.roleId !== roleId) return line;
    if (line.read) {
      keptReadLineIds.push(line.id);
      return line; // readByActorId 已固定，归属不动
    }
    transferredLineIds.push(line.id);
    return { ...line, currentActorId: toActorId };
  });

  const transferredCueIds: string[] = [];
  const cues: StageCue[] = session.cues.map((cue) => {
    if (cue.ownerRoleId !== roleId || cue.delivered) return cue;
    transferredCueIds.push(cue.id);
    return { ...cue, assigneeActorId: toActorId };
  });
  // 演员疑问（questions）完全不动：不随角色转走。

  const appliedVersion = session.version + 1;
  const handover: Handover = {
    id: uid('ho'),
    sessionId,
    roleId,
    fromActorId,
    toActorId,
    baseVersion,
    appliedVersion,
    reason,
    appliedAt: at,
    transferredLineIds,
    keptReadLineIds,
    transferredCueIds,
  };

  const nextSession: RehearsalSession = {
    ...session,
    version: appliedVersion,
    roles: session.roles.map((r) => (r.roleId === roleId ? { ...r, currentActorId: toActorId } : r)),
    lines,
    cues,
    handovers: [...session.handovers, handover],
  };

  const nextState: HandoverServerState = {
    ...state,
    sessions: state.sessions.map((s) => (s.id === sessionId ? nextSession : s)),
  };

  const result: HandoverResult = {
    status: 'applied',
    sessionId,
    roleId,
    fromActorId,
    toActorId,
    reason,
    baseVersion,
    currentVersion: appliedVersion,
    conflicts: [],
    handover,
    audit: {
      id: uid('au'),
      at,
      windowId,
      sessionId,
      type: 'handover-applied',
      summary: `角色「${role.roleName}」${actorName(state, fromActorId)} → ${toActor.name}，场次升至 v${appliedVersion}`,
      detail:
        [
          baseVersion !== session.version
            ? `版本合并：请求基于 v${baseVersion}，期间仅其他角色交接，已在当前 v${session.version} 上重放`
            : '',
          reason ? `换角原因：${reason}` : '',
          `已读保留 ${keptReadLineIds.length} 条（仍记 ${actorName(state, fromActorId)} 名下）`,
          `未读台词转交 ${transferredLineIds.length} 条；未执行场记提示转交 ${transferredCueIds.length} 条`,
          '演员私有疑问不随角色转移',
        ]
          .filter(Boolean)
          .join('\n') || undefined,
    },
  };

  return {
    state: { ...nextState, audit: [result.audit, ...nextState.audit] },
    result,
  };
}

/** 列出 baseVersion 之后该角色相关的全部已生效交接，作为冲突条目。 */
export function buildVersionConflicts(
  session: RehearsalSession,
  roleId: string,
  baseVersion: number,
): ConflictItem[] {
  const newer = session.handovers.filter((h) => h.appliedVersion > baseVersion && h.roleId === roleId);
  const role = session.roles.find((r) => r.roleId === roleId);
  const items: ConflictItem[] = [
    {
      id: 'session-version',
      label: '场次版本',
      detail: `请求基于 v${baseVersion}，当前已为 v${session.version}；期间角色「${role?.roleName ?? roleId}」已有 ${newer.length} 次换人生效，晚到提交不会覆盖它们`,
    },
  ];
  newer.forEach((h, index) => {
    items.push({
      id: `conflict-${h.id}`,
      label: `已生效交接 #${index + 1}（v${h.appliedVersion}，${new Date(h.appliedAt).toLocaleTimeString()}）`,
      detail: `${h.fromActorId} → ${h.toActorId}；转交未读台词 ${h.transferredLineIds.length} 条、提示 ${h.transferredCueIds.length} 条。原因：${h.reason || '未填'}`,
    });
  });
  return items;
}

/** 断网请求恢复后按场次版本合并：直接复用统一提交流程，冲突/拒绝都会落到审计。 */
export function mergePending(
  state: HandoverServerState,
  pending: PendingHandover,
  windowId: string,
  at: number,
): { state: HandoverServerState; result: HandoverResult } {
  return applyHandover({
    state,
    sessionId: pending.sessionId,
    roleId: pending.roleId,
    fromActorId: pending.fromActorId,
    toActorId: pending.toActorId,
    reason: pending.reason,
    baseVersion: pending.baseVersion,
    windowId,
    at,
  });
}
