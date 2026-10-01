export function Injectable(_config?: unknown): ClassDecorator {
  return ((target: unknown) => target) as unknown as ClassDecorator;
}
