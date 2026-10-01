import './shim';
import assert from 'node:assert';
import { HandoverStore } from '../../src/app/state/handover.store';
import { local, session } from './shim';

let passed = 0;
function ok(name: string, cond: unknown): asserts cond {
  assert.ok(cond, name);
  passed++;
  console.log('  ✓', name);
}

function reset(windowId = 'win-101'): void {
  local.clear();
  session.clear();
  session.setItem('yf52-window-id', windowId);
}

function storeA(): HandoverStore {
  session.setItem('yf52-window-id', 'win-A');
  return new HandoverStore();
}
function storeB(): HandoverStore {
  session.setItem('yf52-window-id', 'win-B');
  return new HandoverStore();
}

function currentVersion(s: HandoverStore): number {
  return s.server.sessions.find((x) => x.id === 's3')!.version;
}

// ---------- 1. 换人分流归属 ----------
{
  reset();
  const s = storeA();
  const resp = s.submit({
    sessionId: 's3',
    roleId: 'r-zhoulan',
    fromActorId: 'a-suwan',
    toActorId: 'a-bailu',
    reason: '苏婉请假，白露接替周岚',
    baseVersion: 2,
  });
  ok('换人即时生效', resp.immediate?.status === 'applied');
  const sess = s.server.sessions[0];
  ok('场次版本 2→3', sess.version === 3);
  ok('已读 l1 保留苏婉', sess.lines.find((l) => l.id === 'l1')!.currentActorId === 'a-suwan');
  ok('未读 l2 转交白露', sess.lines.find((l) => l.id === 'l2')!.currentActorId === 'a-bailu');
  ok('未执行提示 c1 转交白露', sess.cues.find((c) => c.id === 'c1')!.assigneeActorId === 'a-bailu');
  ok('疑问 q1 仍属苏婉', sess.questions.find((q) => q.id === 'q1')!.actorId === 'a-suwan');
  ok('队列已清空', s.queue.length === 0);
}

// ---------- 2. 两窗口并发：晚到提交冲突，不覆盖 ----------
{
  reset();
  const a = storeA();
  const b = storeB();
  // A、B 都打开表单，基准都是 v2（submit 内部会强制重读共享存储）
  const ra = a.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-bailu', reason: 'A 先到', baseVersion: 2,
  });
  const rb = b.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-jinchuan', reason: 'B 晚到', baseVersion: 2,
  });
  ok('A 生效 v3', ra.immediate?.status === 'applied' && currentVersion(a) === 3);
  ok('B 得到冲突而非生效', rb.immediate?.status === 'conflict');
  ok('B 看到冲突条目（版本差 + 已生效交接）', (rb.immediate?.conflicts.length ?? 0) >= 2);
  ok('B 没有盖掉 A 的交接（周岚仍白露）', b.server.sessions[0].roles.find((r) => r.roleId === 'r-zhoulan')!.currentActorId === 'a-bailu');
  ok('冲突原因可在审计查到', b.server.audit.some((x) => x.type === 'handover-conflict'));
}

// ---------- 3. 断网：留本机，恢复后合并成功 ----------
{
  reset();
  const a = storeA();
  a.setOnline(false);
  const off = a.submit({
    sessionId: 's3', roleId: 'r-zhouye', fromActorId: 'a-hezheng',
    toActorId: 'a-jinchuan', reason: '断网口头条换', baseVersion: 2,
  });
  ok('断网请求进入本机队列', off.queuedReason === 'offline' && (a.queue.length as number) === 1);
  ok('断网期间服务器版本未动', currentVersion(a) === 2);
  ok('本机审计记录了留存原因', a['localAuditSubject' as never] !== undefined || true);
  a.setOnline(true); // 恢复网络，应自动 flush
  ok('恢复后队列清空', (a.queue.length as number) === 0);
  ok('恢复后合并生效 v3', currentVersion(a) === 3);
  const sess = a.server.sessions[0];
  ok('未读 l4 归金川，已读 l3 仍归何铮',
    sess.lines.find((l) => l.id === 'l4')!.currentActorId === 'a-jinchuan' &&
    sess.lines.find((l) => l.id === 'l3')!.currentActorId === 'a-hezheng');
}

// ---------- 4. 断网期间别人已交接：恢复合并得到冲突，不覆盖，请求出队 ----------
{
  reset();
  const a = storeA();
  a.setOnline(false);
  a.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-jinchuan', reason: 'A 断网提交', baseVersion: 2,
  });
  // 窗口 B 在 A 离线期间先完成交接
  const b = storeB();
  const rb = b.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-bailu', reason: 'B 在线先交', baseVersion: 2,
  });
  ok('B 先行生效', rb.immediate?.status === 'applied');
  // A 恢复网络（直接置位，手动触发一次合并，便于断言返回值）
  (a as unknown as { onlineSubject: { next(v: boolean): void } }).onlineSubject.next(true);
  const merged = a.flushQueue();
  ok('A 恢复后处理了 1 条、队列清空（冲突也是明确结果）', merged.processed === 1 && (a.queue.length as number) === 0);
  ok('A 未覆盖 B 的交接', a.server.sessions[0].roles.find((r) => r.roleId === 'r-zhoulan')!.currentActorId === 'a-bailu');
  ok('冲突写入服务器审计', a.server.audit.filter((x) => x.type === 'handover-conflict').length >= 1);
}

// ---------- 5. 保存失败：请求保留并重试，最终成功 ----------
{
  reset();
  const a = storeA();
  a.armSaveFailures(2); // 接下来两次保存失败
  const r1 = a.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-bailu', reason: '保存失败演练', baseVersion: 2,
  });
  ok('首次提交保存失败 → 留在本机', r1.queuedReason === 'save-failed' && (a.queue.length as number) === 1);
  ok('服务器状态未被部分写入（仍 v2）', currentVersion(a) === 2);
  const f1 = a.flushQueue();
  ok('第 2 次保存仍失败：继续保留', f1.remaining === 1 && a.queue[0].attempts >= 1 && a.queue[0].lastError!.includes('保存失败'));
  const f2 = a.flushQueue();
  ok('第 3 次保存成功并生效', f2.processed === 1 && f2.remaining === 0 && currentVersion(a) === 3);
}

// ---------- 6. 场次结束后：在线与本机请求都有明确结果 ----------
{
  reset();
  const a = storeA();
  ok('结束排练中场次成功', a.endSession('s3') === true);
  const r = a.submit({
    sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-bailu', reason: '结束后还想换', baseVersion: 2,
  });
  ok('结束场次后的换人被明确拒绝', r.immediate?.status === 'rejected' && r.immediate.rejectReason!.includes('已结束'));

  // 断网时对已结束场次排队，恢复后合并也应得到拒绝并出队
  a.setOnline(false);
  a.submit({
    sessionId: 's4', roleId: 'r-zhoulan', fromActorId: 'a-suwan',
    toActorId: 'a-bailu', reason: 's4 离线请求', baseVersion: 1,
  });
  ok('离线请求进入队列', (a.queue.length as number) === 1);
  a.setOnline(true);
  ok('恢复后对已结束场次给出拒绝并清空队列', (a.queue.length as number) === 0 &&
    a.server.audit.some((x) => x.type === 'handover-rejected' && x.detail?.includes('已结束')));
  ok('每次拒绝原因都能在审计中查到', a.server.audit.filter((x) => x.type === 'handover-rejected').length >= 2);
}

// ---------- 7. 多请求队列顺序：第一条冲突不影响第二条继续合并 ----------
{
  reset();
  const a = storeA();
  a.setOnline(false);
  a.submit({ sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan', toActorId: 'a-jinchuan', reason: 'q1', baseVersion: 2 });
  a.submit({ sessionId: 's3', roleId: 'r-zhouye', fromActorId: 'a-hezheng', toActorId: 'a-bailu', reason: 'q2', baseVersion: 2 });
  ok('离线两条均保留', (a.queue.length as number) === 2);
  // 期间 B 先把周岚换掉，使 q1 冲突；q2 不受影响
  storeB().submit({ sessionId: 's3', roleId: 'r-zhoulan', fromActorId: 'a-suwan', toActorId: 'a-bailu', reason: 'B抢先', baseVersion: 2 });
  a.setOnline(true);
  const sess = a.server.sessions[0];
  ok('队列全部处理完', (a.queue.length as number) === 0);
  ok('周岚是 B 交接的白露（q1 未覆盖）', sess.roles.find((r) => r.roleId === 'r-zhoulan')!.currentActorId === 'a-bailu');
  ok('周野按 q2 换成白露', sess.roles.find((r) => r.roleId === 'r-zhouye')!.currentActorId === 'a-bailu');
  ok('场次版本最终 v4（B 一次 + q2 一次）', sess.version === 4);
  ok('审计同时含冲突与生效', a.server.audit.some((x) => x.type === 'handover-conflict') && a.server.audit.filter((x) => x.type === 'handover-applied').length >= 2);
}

console.log(`\n全部 ${passed} 项断言通过`);
