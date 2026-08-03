/** Permission gate: allow / deny / ask, with per-tool overrides. */

export type PermissionRule = 'ask' | 'allow' | 'deny';
export type AskResponse = 'yes' | 'no' | 'always' | 'never';

export interface PermissionGateOptions {
  /** Default rules by tool name (e.g. read → allow, bash → ask). */
  rules?: Record<string, PermissionRule>;
  /** Prompt the user; must resolve to one of the AskResponse values. */
  ask(prompt: string): Promise<AskResponse>;
}

export class PermissionGate {
  private rules: Record<string, PermissionRule>;
  private overrides = new Map<string, PermissionRule>();
  private readonly askFn: (p: string) => Promise<AskResponse>;

  constructor(opts: PermissionGateOptions) {
    this.rules = { ...opts.rules };
    this.askFn = opts.ask;
  }

  /** Set a persistent per-tool override (e.g. from /permission allow bash). */
  setOverride(toolName: string, rule: PermissionRule): void {
    this.overrides.set(toolName, rule);
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
