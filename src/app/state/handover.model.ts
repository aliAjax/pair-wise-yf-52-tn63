/**
 * 场次角色交接领域模型。
 *
 * 关键约束：
 * - 换人按"场次版本"做乐观并发控制，每次成功交接场次版本 +1。
 * - 读过的台词固定记在读它的演员名下；未读台词与未执行的场记提示转给接替者。
 * - 演员私下写的疑问只挂演员，不随角色转移。
 */

export type SessionStatus = 'rehearsing' | 'ended';

export interface Actor {
  id: string;
  name: string;
}

export interface RoleState {
  roleId: string;
  roleName: string;
  currentActorId: string;
}

export interface ScriptLine {
  id: string;
  roleId: string;
  text: string;
  /** 是否在排练中读过。读过即定稿，交接不再改变归属。 */
  read: boolean;
  /** 读过该台词的演员；一旦写入即固定。 */
  readByActorId?: string;
  /** 当前对该条负责的演员：未读随角色走，读过固定为读它的人。 */
  currentActorId: string;
}

export interface StageCue {
  id: string;
  scene: string;
  text: string;
  ownerRoleId: string;
  /** 场记提示当前执行人：未执行随角色交接，已执行则保留。 */
  assigneeActorId: string;
  delivered: boolean;
}

export interface ActorQuestion {
  id: string;
  lineId?: string;
  text: string;
  /** 写疑问的演员。疑问是演员私有的，换人不转移。 */
  actorId: string;
  createdAt: number;
}

export interface Handover {
  id: string;
  sessionId: string;
  roleId: string;
  fromActorId: string;
  toActorId: string;
  /** 提交方所依据的场次版本（用于晚到提交的版本比对）。 */
  baseVersion: number;
  /** 生效后场次版本。 */
  appliedVersion: number;
  reason: string;
  appliedAt: number;
  /** 本次转给接替者的未读台词。 */
  transferredLineIds: string[];
  /** 保留在原演员名下的已读台词。 */
  keptReadLineIds: string[];
  /** 本次转给接替者的未执行场记提示。 */
  transferredCueIds: string[];
}

export interface RehearsalSession {
  id: string;
  title: string;
  status: SessionStatus;
  /** 场次当前版本，每次成功交接 +1。 */
  version: number;
  roles: RoleState[];
  lines: ScriptLine[];
  cues: StageCue[];
  questions: ActorQuestion[];
  handovers: Handover[];
}

export type AuditType =
  | 'handover-applied'
  | 'handover-conflict'
  | 'handover-rejected'
  | 'session-ended'
  | 'queue-kept'
  | 'save-failed';

export interface AuditEntry {
  id: string;
  at: number;
  windowId: string;
  sessionId: string;
  type: AuditType;
  summary: string;
  /** 多行人类可读明细（冲突条目 / 拒绝原因）。 */
  detail?: string;
}

export interface HandoverServerState {
  actors: Actor[];
  sessions: RehearsalSession[];
  audit: AuditEntry[];
}

export interface ConflictItem {
  id: string;
  label: string;
  detail: string;
}

/** 断网或保存失败时留在本机的换人请求。 */
export interface PendingHandover {
  id: string;
  sessionId: string;
  roleId: string;
  fromActorId: string;
  toActorId: string;
  reason: string;
  /** 提交瞬间快照的场次版本，恢复后据此与服务器版本合并。 */
  baseVersion: number;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

export type HandoverStatus = 'applied' | 'conflict' | 'rejected';

export interface HandoverResult {
  status: HandoverStatus;
  sessionId: string;
  roleId: string;
  fromActorId: string;
  toActorId: string;
  reason: string;
  baseVersion: number;
  currentVersion: number;
  conflicts: ConflictItem[];
  rejectReason?: string;
  handover?: Handover;
  audit: AuditEntry;
}
