/**
 * Agent lanes (fork): 群里的 Agent 成员与 @-路由。
 *
 * 与 threadSessions 的关系：线程仍是"会话的容器"，但一条线程里可以有多条
 * Agent 车道 —— 车道键 = `room :: laneRoot :: agent`。无 @ 的消息永远不走
 * 这里，保持原有语义。
 *
 * 本模块只做纯逻辑（可单测）：名单扫描、@-解析、车道键、历史窗口、防环计数。
 * 进程生命周期与消息投递在 ProjectManager / message-router 里。
 */

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { logger } from "../logger.js";

/** 一个 Agent 定义：`<dir>/<name>.md`，YAML frontmatter + 正文 system prompt。 */
export interface AgentSpec {
  /** Agent 名（frontmatter 的 name，缺省取文件名去后缀）。 */
  name: string;
  description?: string;
  /** frontmatter 的 model，形如 `provider/id` 或 `provider/id:thinking`。 */
  model?: string;
  /** frontmatter 的 thinking：off|minimal|low|medium|high|xhigh|max。 */
  thinking?: string;
  /** frontmatter 的 tools，逗号分隔。 */
  tools?: string;
  /** 正文（去掉 frontmatter），作为 `--append-system-prompt` 的内容。 */
  systemPrompt: string;
  /** 定义文件所在目录。 */
  sourceDir: string;
}

/** thinking 的合法枚举（与 pi 的 settings-schema 同源）。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Agent 名允许的形状：小写字母数字与连字符/下划线，1-40 位。 */
const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name);
}

/** 解析 md 的 frontmatter（只认单层 `key: value`，足够 agent 定义用）。 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: {}, body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: text.trim() };
  const header = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, "").trim();
  const meta: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, "");
    if (value) meta[m[1]!] = value;
  }
  return { meta, body };
}

/** 读取一个定义文件；非法或读不到返回 undefined（扫描不因坏文件整体失败）。 */
export function readAgentSpec(file: string): AgentSpec | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    const name = (meta.name ?? path.basename(file).replace(/\.md$/i, "")).trim();
    if (!isValidAgentName(name)) {
      logger.warn(`⚠️ Agent 定义名不合法,已跳过: ${file}`);
      return undefined;
    }
    if (!body) {
      logger.warn(`⚠️ Agent 定义没有正文,已跳过: ${file}`);
      return undefined;
    }
    return {
      name,
      ...(meta.description && { description: meta.description }),
      ...(meta.model && { model: meta.model }),
      ...(meta.thinking && { thinking: meta.thinking }),
      ...(meta.tools && { tools: meta.tools }),
      systemPrompt: body,
      sourceDir: path.dirname(file),
    };
  } catch (err) {
    logger.warn(`⚠️ 读取 Agent 定义失败 ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * 扫描若干目录，汇总 Agent 名册（同名先到先得，后者忽略并告警）。
 * 目录不存在直接跳过 —— 默认目录在新机器上常常为空。
 */
export function scanAgentRoster(dirs: readonly string[]): Map<string, AgentSpec> {
  const roster = new Map<string, AgentSpec>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      continue; // 目录不存在 / 无权限：跳过，不是错误
    }
    for (const entry of entries.sort()) {
      const spec = readAgentSpec(path.join(dir, entry));
      if (!spec) continue;
      if (roster.has(spec.name)) {
        logger.warn(`⚠️ Agent 重名,忽略后者: ${spec.name} (${path.join(dir, entry)})`);
        continue;
      }
      roster.set(spec.name, spec);
    }
  }
  return roster;
}

/**
 * 从消息文本里解析目标 Agent 名。
 *
 * 两种形态都认：
 * - `@name`（中文输入法友好，最常见的写法）
 * - `@name:server`（某些客户端补全会带上域名；只要 `name` 在册就认）
 *
 * `server` 可以省略或任意，名字必须在名单里才算数。`@` 前面不能紧贴 ASCII
 * 字母数字（邮箱不误触），中文/标点/空白/行首都可以。按出现顺序去重。
 *
 * `botUserId`（如 `@steward:matrix.localhost`）永远不算 Agent 目标。
 */
export function parseAgentMentions(
  text: string,
  roster: ReadonlySet<string>,
  botUserId?: string
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // 桥接账号自己的用户名:它在名册里可能也有同名定义(比如管家 steward.md),
  // 但 `@steward` 永远是"跟这个账号说话",不是"派给同名专家" —— 带不带
  // `:server` 都排除,否则同一个名字既是账号又是虚拟角色,回复会串身份。
  const botName = botUserId ? /^@([^:]+):/.exec(botUserId)?.[1]?.toLowerCase() : undefined;
  // 前置边界:「@」前面不能紧贴 ASCII 字母/数字/下划线/连字符 —— 这样邮箱
  // `a@researcher.com` 不会被误认,而中文紧邻(`帮我@critic`)、标点、空白、
  // 行首都照常生效(中文输入法下最常见的写法)。前置字符被这条正则一并吃掉,
  // 不影响后续 @ 的匹配。
  const re = /(?:^|[^A-Za-z0-9_-])@([A-Za-z][A-Za-z0-9_-]{0,39})(?::([A-Za-z0-9.-]+))?/g;
  for (const m of text.matchAll(re)) {
    const name = m[1]!;
    const server = m[2];
    if (botName && name.toLowerCase() === botName) continue;
    if (botUserId && server && botUserId.toLowerCase() === `@${name}:${server}`.toLowerCase()) continue;
    if (!roster.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 车道键：一条线程 × 一个 Agent。room 与 laneRoot 用不可见分隔符拼接。 */
export function agentLaneKey(roomId: string, laneRoot: string, agent: string): string {
  return `${roomId}\u0000${laneRoot}\u0000${agent}`;
}

/** 供日志/目录名使用的短标识（清洗 + 哈希，避免事件 id 里的符号进路径）。 */
export function safeSlug(raw: string, maxLen = 40): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, maxLen);
}

// ── 线程历史窗口 ──────────────────────────────────────────────────────────

export interface HistoryEntry {
  /** 展示名：人类用户给 `@jarcis`，Agent 给 `[name]`。 */
  who: string;
  text: string;
  /** epoch ms。 */
  at: number;
}

/**
 * 每条线程一个定长环。Agent 车道派发时取最近 N 条拼进 prompt ——
 * 目的只是"看见本线程刚才在聊什么"，不是全量记忆（全量在领域文件里）。
 */
export class ThreadHistory {
  private rings = new Map<string, HistoryEntry[]>();

  constructor(private readonly capacity = 60) {}

  record(threadKey: string, entry: HistoryEntry): void {
    const ring = this.rings.get(threadKey) ?? [];
    ring.push(entry);
    if (ring.length > this.capacity) ring.splice(0, ring.length - this.capacity);
    this.rings.set(threadKey, ring);
  }

  /** 最近 limit 条，按时间正序；不含 `excludeEventId` 对应条目不在这里处理
   *  —— 调用方应在记录当前消息之前取窗口。 */
  window(threadKey: string, limit = 30): HistoryEntry[] {
    const ring = this.rings.get(threadKey) ?? [];
    return ring.slice(-Math.max(1, limit));
  }

  clear(threadKey: string): void {
    this.rings.delete(threadKey);
  }
}

/** 把历史窗口渲染成注入 prompt 的文本块；空窗口返回空串。 */
export function renderHistoryWindow(entries: readonly HistoryEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => {
    const stamp = new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false });
    return `[${stamp}] ${e.who}: ${e.text}`;
  });
  return ["[本线程最近的消息（供上下文，不要逐条复述）]", ...lines, "[/最近消息]"].join("\n");
}

// ── 防环：Agent 互 @ 的连续跳数 ───────────────────────────────────────────

export interface HopDecision {
  /** 是否允许继续路由。 */
  allowed: boolean;
  /** 本跳之后的连续跳数（allowed=false 时也已推进到上限值）。 */
  hop: number;
}

/**
 * 无用户介入的 Agent→Agent 连续跳数护栏。
 *
 * 计数按线程维护：用户发言把它清零；每次 Agent 回复里的 @ 触发路由 +1。
 * 超过上限即拒绝，由调用方在群里提示介入。另外带一个静默期：距上一次
 * Agent 跳超过 `resetMinutes` 分钟就当作新话题重新计数，避免一次跑飞
 * 让这条线程当天再也用不了。
 */
export class HopGuard {
  private hops = new Map<string, { hop: number; at: number }>();

  constructor(
    private readonly maxHops: number,
    private readonly resetMinutes = 10
  ) {}

  /** 用户消息 = 人工介入：清零。 */
  noteUserTurn(threadKey: string): void {
    this.hops.delete(threadKey);
  }

  /** 尝试推进一跳。allowed=false 表示已到上限，调用方应停止路由并提示。 */
  tryHop(threadKey: string, now = Date.now()): HopDecision {
    const cur = this.hops.get(threadKey);
    const stale = cur ? now - cur.at > this.resetMinutes * 60_000 : false;
    const base = cur && !stale ? cur.hop : 0;
    const next = base + 1;
    this.hops.set(threadKey, { hop: next, at: now });
    return { allowed: next <= this.maxHops, hop: next };
  }

  current(threadKey: string): number {
    return this.hops.get(threadKey)?.hop ?? 0;
  }

  clear(threadKey: string): void {
    this.hops.delete(threadKey);
  }
}

/** Agent 回复的身份标注前缀，如 `[vuln-review] `。已在开头则不重复加。 */
export function labelAgentReply(agent: string, text: string): string {
  const prefix = `[${agent}] `;
  return text.startsWith(prefix) ? text : prefix + text;
}

/** 从 Agent 回复里剥掉自己的标注，再解析 @（避免 `[a] @a` 自触发）。 */
export function stripAgentLabel(agent: string, text: string): string {
  const prefix = `[${agent}] `;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}


