/** Permission gate: allow / deny / ask, with per-tool overrides. */

export type PermissionRule = 'ask' | 'allow' | 'deny';
export type AskResponse = 'yes' | 'no' | 'always' | 'never';

export interface PermissionGateOptions {
  /** Default rules by tool name (e.g. read → allow, bash → ask). */
  rules?: Record<string, PermissionRule>;
  /** Prompt the user; must resolve to one of the AskResponse values. */
  ask(prompt: string): Promise<AskResponse>;
  /** Fired whenever a persistent override changes (e.g. to persist to disk). */
  onOverride?: (toolName: string, rule: PermissionRule) => void;
}

export class PermissionGate {
  private rules: Record<string, PermissionRule>;
  private overrides = new Map<string, PermissionRule>();
  private readonly askFn: (p: string) => Promise<AskResponse>;
  private readonly onOverride?: (toolName: string, rule: PermissionRule) => void;
  private yoloOn = false;

  constructor(opts: PermissionGateOptions) {
    this.rules = { ...opts.rules };
    this.askFn = opts.ask;
    this.onOverride = opts.onOverride;
  }

  /**
   * Yolo mode: every check auto-allows — no prompts, no ask, even for `deny`
   * rules and the `__ask__` channel (plan approval). Toggleable at runtime.
   */
  setYolo(on: boolean): void {
    this.yoloOn = on;
  }

  get yolo(): boolean {
    return this.yoloOn;
  }

  /** Set a persistent per-tool override (e.g. from /permission allow bash). */
  setOverride(toolName: string, rule: PermissionRule): void {
    this.overrides.set(toolName, rule);
    this.onOverride?.(toolName, rule);
  }

  /** Snapshot of all persistent per-tool overrides (for saving to disk). */
  listOverrides(): Record<string, PermissionRule> {
    return { ...Object.fromEntries(this.overrides) };
  }

  clearOverride(toolName: string): void {
    this.overrides.delete(toolName);
  }

  ruleFor(toolName: string): PermissionRule {
    return this.overrides.get(toolName) ?? this.rules[toolName] ?? 'ask';
  }

  async check(
    toolName: string,
    detail: string,
  ): Promise<{ allowed: boolean; rule: PermissionRule }> {
    if (this.yoloOn) return { allowed: true, rule: 'allow' };
    const rule = this.ruleFor(toolName);
    if (rule === 'allow') return { allowed: true, rule };
    if (rule === 'deny') return { allowed: false, rule };
    const answer = await this.askFn(`允許執行 ${toolName}？\n${detail}`);
    switch (answer) {
      case 'yes':
        return { allowed: true, rule };
      case 'always':
        this.setOverride(toolName, 'allow');
        return { allowed: true, rule: 'allow' };
      case 'never':
        this.setOverride(toolName, 'deny');
        return { allowed: false, rule: 'deny' };
      default:
        return { allowed: false, rule };
    }
  }
}
