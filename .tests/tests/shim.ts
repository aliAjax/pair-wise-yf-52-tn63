// 必须最先导入：为 HandoverStore 提供最小浏览器环境。
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
}

const local = new MemoryStorage();
const session = new MemoryStorage();

(globalThis as Record<string, unknown>).localStorage = local;
(globalThis as Record<string, unknown>).sessionStorage = session;
(globalThis as Record<string, unknown>).navigator = { onLine: true };
(globalThis as Record<string, unknown>).window = {
  addEventListener(): void {},
  // 不启动真实定时器
};
(globalThis as Record<string, unknown>).setInterval = () => 0;
(globalThis as Record<string, unknown>).clearInterval = () => {};

export { local, session };
