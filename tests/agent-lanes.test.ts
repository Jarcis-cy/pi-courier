import { describe, expect, it } from "vitest";
import {
  agentLaneKey,
  HopGuard,
  labelAgentReply,
  parseAgentMentions,
  parseFrontmatter,
  renderHistoryWindow,
  scanAgentRoster,
  stripAgentLabel,
  ThreadHistory,
  isValidAgentName,
} from "../src/rpc/agent-lanes";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROSTER = new Set(["vuln-review", "test-ops", "researcher", "critic"]);

describe("@-解析(文本形态)", () => {
  it("单个 @name → 一个目标", () => {
    expect(parseAgentMentions("@vuln-review 看下这个洞", ROSTER)).toEqual(["vuln-review"]);
  });

  it("多个 @ → 按出现顺序去重", () => {
    expect(parseAgentMentions("@vuln-review 和 @test-ops 一起看,@vuln-review 先说", ROSTER)).toEqual([
      "vuln-review",
      "test-ops",
    ]);
  });

  it("不认识的 @ 不算目标(普通文本/@某人 不触发)", () => {
    expect(parseAgentMentions("@jarcis 你好 @张三", ROSTER)).toEqual([]);
  });

  it("没有 @ → 空列表", () => {
    expect(parseAgentMentions("今天测试有点慢", ROSTER)).toEqual([]);
  });

  it("完整 MXID 形态也能认(只要名字在册)", () => {
    expect(parseAgentMentions("@vuln-review:matrix.localhost 看下", ROSTER)).toEqual(["vuln-review"]);
  });

  it("bot 自己的 MXID 不会变成 Agent 目标", () => {
    expect(
      parseAgentMentions("@steward:matrix.localhost 你好", ROSTER, "@steward:matrix.localhost")
    ).toEqual([]);
  });

  it("裸 @bot 用户名也不当 Agent 目标(哪怕名册里有同名定义)", () => {
    // 名册里同时存在 steward 时,`@steward` 仍应视为"跟账号说话"
    const withBot = new Set([...ROSTER, "steward"]);
    expect(parseAgentMentions("@steward 介绍一下你自己", withBot, "@steward:matrix.localhost")).toEqual([]);
    expect(
      parseAgentMentions("@steward:matrix.localhost 介绍一下你自己", withBot, "@steward:matrix.localhost")
    ).toEqual([]);
  });

  it("邮箱不会被误认(前置字符是 ASCII 字母)", () => {
    expect(parseAgentMentions("发到 a@researcher.com", ROSTER)).toEqual([]);
  });

  it("中文紧邻、行首、标点、换行都算边界", () => {
    expect(parseAgentMentions("帮我@critic看看", ROSTER)).toEqual(["critic"]);
    expect(parseAgentMentions("@critic 看下", ROSTER)).toEqual(["critic"]);
    expect(parseAgentMentions("麻烦看下(@critic)", ROSTER)).toEqual(["critic"]);
    expect(parseAgentMentions("第一行\n@critic 第二行", ROSTER)).toEqual(["critic"]);
    expect(parseAgentMentions("结论,@critic 复核", ROSTER)).toEqual(["critic"]);
  });

  it("紧贴 ASCII 标识符的 @ 不算(避免变量名/路径误触)", () => {
    expect(parseAgentMentions("user_critic@critic 是邮箱前缀", ROSTER)).toEqual([]);
    expect(parseAgentMentions("path/critic@critic", ROSTER)).toEqual([]);
  });

  it("名字必须合法形状", () => {
    expect(isValidAgentName("vuln-review")).toBe(true);
    expect(isValidAgentName("a_b")).toBe(true);
    expect(isValidAgentName("-bad")).toBe(false);
    expect(isValidAgentName("有中文")).toBe(false);
  });
});

describe("车道键", () => {
  it("同线程不同 Agent 不同键;不同线程同 Agent 不同键", () => {
    const a = agentLaneKey("!r:s", "$t1", "vuln-review");
    const b = agentLaneKey("!r:s", "$t1", "test-ops");
    const c = agentLaneKey("!r:s", "$t2", "vuln-review");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(agentLaneKey("!r:s", "$t1", "vuln-review")).toBe(a);
  });
});

describe("防环计数", () => {
  it("连续跳数到上限后拒绝,用户发言清零", () => {
    const g = new HopGuard(3);
    const key = "!r:s\u0000$t";
    expect(g.tryHop(key).allowed).toBe(true); // 1
    expect(g.tryHop(key).allowed).toBe(true); // 2
    expect(g.tryHop(key).allowed).toBe(true); // 3
    const over = g.tryHop(key); // 4
    expect(over.allowed).toBe(false);
    expect(over.hop).toBe(4);

    g.noteUserTurn(key);
    expect(g.current(key)).toBe(0);
    expect(g.tryHop(key).allowed).toBe(true); // 重新从 1 起
  });

  it("静默期过后重新计数", () => {
    const g = new HopGuard(2, 10);
    const key = "!r:s\u0000$t";
    g.tryHop(key);
    g.tryHop(key);
    expect(g.tryHop(key).allowed).toBe(false);
    // 11 分钟后:当作新话题
    const later = Date.now() + 11 * 60_000;
    expect(g.tryHop(key, later).allowed).toBe(true);
  });

  it("不同线程互不影响", () => {
    const g = new HopGuard(1);
    expect(g.tryHop("k1").allowed).toBe(true);
    expect(g.tryHop("k1").allowed).toBe(false);
    expect(g.tryHop("k2").allowed).toBe(true);
  });
});

describe("身份标注", () => {
  it("加前缀且不重复加", () => {
    expect(labelAgentReply("test-ops", "完成")).toBe("[test-ops] 完成");
    expect(labelAgentReply("test-ops", "[test-ops] 完成")).toBe("[test-ops] 完成");
  });

  it("剥前缀用于解析互 @", () => {
    expect(stripAgentLabel("test-ops", "[test-ops] 已看")).toBe("已看");
    expect(stripAgentLabel("test-ops", "裸文本")).toBe("裸文本");
  });
});

describe("历史窗口", () => {
  it("定长环:超出容量丢最旧", () => {
    const h = new ThreadHistory(3);
    for (let i = 0; i < 5; i += 1) h.record("k", { who: "u", text: String(i), at: i });
    expect(h.window("k", 10).map((e) => e.text)).toEqual(["2", "3", "4"]);
  });

  it("limit 取最近 N 条且保持时间正序", () => {
    const h = new ThreadHistory(10);
    for (let i = 0; i < 6; i += 1) h.record("k", { who: "u", text: String(i), at: i });
    expect(h.window("k", 2).map((e) => e.text)).toEqual(["4", "5"]);
  });

  it("渲染带发言人标注;空窗口返回空串", () => {
    const h = new ThreadHistory(10);
    expect(renderHistoryWindow(h.window("k", 5))).toBe("");
    h.record("k", { who: "@jarcis", text: "测试好慢", at: Date.now() });
    h.record("k", { who: "[test-ops]", text: "我看下", at: Date.now() });
    const out = renderHistoryWindow(h.window("k", 5));
    expect(out).toContain("@jarcis: 测试好慢");
    expect(out).toContain("[test-ops]: 我看下");
  });
});

describe("Agent 定义解析", () => {
  it("frontmatter + 正文", () => {
    const { meta, body } = parseFrontmatter(
      ["---", "name: critic", "model: zai-coding-cn/glm-5.3", "thinking: max", "---", "", "你是评审员。"].join("\n")
    );
    expect(meta.name).toBe("critic");
    expect(meta.model).toBe("zai-coding-cn/glm-5.3");
    expect(body).toBe("你是评审员。");
  });

  it("没有 frontmatter 时整篇都是正文", () => {
    const { meta, body } = parseFrontmatter("你是评审员。");
    expect(meta).toEqual({});
    expect(body).toBe("你是评审员。");
  });

  it("扫描目录:跳过坏文件,同名先到先得", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lanes-"));
    const d1 = path.join(root, "a");
    const d2 = path.join(root, "b");
    fs.mkdirSync(d1);
    fs.mkdirSync(d2);
    fs.writeFileSync(path.join(d1, "one.md"), "---\nname: one\ndescription: 第一个\n---\n你是 one。");
    fs.writeFileSync(path.join(d1, "broken.md"), "---\nname: bad name\n---\n坏了");
    fs.writeFileSync(path.join(d2, "one.md"), "---\nname: one\n---\n重复的 one");
    fs.writeFileSync(path.join(d2, "two.md"), "---\nname: two\nmodel: p/m\n---\n你是 two。");

    const roster = scanAgentRoster([d1, d2, path.join(root, "missing")]);
    expect([...roster.keys()].sort()).toEqual(["one", "two"]);
    expect(roster.get("one")?.systemPrompt).toBe("你是 one。");
    expect(roster.get("two")?.model).toBe("p/m");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
