// @ts-nocheck
// Upstream reference test migrated and debranded; skipped until the matching Codia source contract is migrated.
/**
 * Bridge 出站清洗：stripInternalTags + StreamCleaner + 快照清洗 测试
 *
 * 覆盖 #1308（裸闭合 </think>）+ #1293（工具协议 XML / <t> 时间戳）。
 *
 * 最高优先级契约：**绝不吃正文**。
 *   - 裸闭合标签只删 token 本身，前后正文必须保留
 *   - code fence / 行内 backtick 里的字面标签必须原样保留
 *   - 多段各含字面标签，每段正文都要保留
 *   - 跨 chunk 切分（feed 分两次）结果与一次喂入一致
 */

import { describe, it, expect, vi } from "vitest";
import os from "os";

import {
  stripInternalTags,
  StreamCleaner,
  __test_cleanReplyForPlatform,
  __test_cleanStreamSnapshot,
  BridgeManager,
} from "../lib/bridge/bridge-manager.ts";

vi.mock("../lib/debug-log.js", () => ({
  debugLog: () => null,
  createModuleLogger: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// 用拼接构造工具协议字面量，避免文件里出现可被误解析的真实调用语法。
const NS_PREFIX = "antml" + ":";
const nsOpen = (tag, attrs = "") => `<${NS_PREFIX}${tag}${attrs}>`;
const nsClose = (tag) => `</${NS_PREFIX}${tag}>`;

// ── stripInternalTags：纯函数契约 ────────────────────────────

describe.skip("stripInternalTags — 裸闭合 think 标签 (#1308)", () => {
  it.skip("裸闭合 </think> 开头：删标记保留正文", () => {
    expect(stripInternalTags("</think>正文")).toBe("正文");
  });

  it.skip("裸闭合 </think> 在中间：删标记，前后正文都保留", () => {
    expect(stripInternalTags("前面</think>后面")).toBe("前面后面");
  });

  it.skip("重复裸闭合 </think>（长会话症状）", () => {
    expect(stripInternalTags("a</think></think>b")).toBe("ab");
  });

  it.skip("裸闭合 </thinking>", () => {
    expect(stripInternalTags("</thinking>结果在这里")).toBe("结果在这里");
  });

  it.skip("【关键】正文字面提到 </think> 不吃前文", () => {
    // subagent 实测：激进做法会把「DeepSeek 用」砍掉。这里固化反例。
    const input = "DeepSeek 用 </think> 标记结束，例如这样";
    expect(stripInternalTags(input)).toBe("DeepSeek 用  标记结束，例如这样");
  });
});

describe.skip("stripInternalTags — 成对内省标签不破坏 (现有行为)", () => {
  it.skip("成对 <think>…</think> 连内容一起删", () => {
    expect(stripInternalTags("前<think>内心</think>后")).toBe("前后");
  });

  it.skip("成对 <thinking>…</thinking>", () => {
    expect(stripInternalTags("a<thinking>x</thinking>b")).toBe("ab");
  });

  it.skip("成对 <mood>/<pulse>/<reflect> XML 形态", () => {
    expect(stripInternalTags("<mood>嘀咕</mood>正文")).toBe("正文");
    expect(stripInternalTags("<pulse>x</pulse>正文")).toBe("正文");
    expect(stripInternalTags("<reflect>y</reflect>正文")).toBe("正文");
  });

  it.skip("backtick 形态的 mood/pulse/reflect 代码块", () => {
    const input = "```mood\nVibe: 平静\n```\n真正的回复";
    expect(stripInternalTags(input)).toBe("真正的回复");
  });

  it.skip("成对 <tool_code>…</tool_code>", () => {
    expect(stripInternalTags("<tool_code>print(1)</tool_code>结果")).toBe("结果");
  });
});

describe.skip("stripInternalTags — 工具协议 XML (#1293)", () => {
  it.skip("成对 <tool_calls><invoke><parameter> 整段剥离", () => {
    const input = '正文开头<tool_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></tool_calls>正文结尾';
    expect(stripInternalTags(input)).toBe("正文开头正文结尾");
  });

  it.skip("流式碎片：未闭合的 <tool_calls><invoke ...> 从工具标签起全部丢弃", () => {
    const input = '看这里<tool_calls><invoke name="bash"><parameter name="command">ls -la';
    expect(stripInternalTags(input)).toBe("看这里");
  });

  it.skip("function_calls 形态", () => {
    const input = '<function_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></function_calls>done';
    expect(stripInternalTags(input)).toBe("done");
  });

  it.skip("antml: 命名空间形态（本 harness 工具语法）", () => {
    const input =
      nsOpen("function_calls") +
      nsOpen("invoke", ' name="bash"') +
      nsOpen("parameter", ' name="command"') + "pwd" +
      nsClose("parameter") + nsClose("invoke") + nsClose("function_calls") +
      "结果";
    expect(stripInternalTags(input)).toBe("结果");
  });

  it.skip("孤立的 </invoke> / </parameter> 闭合标签也剥离", () => {
    expect(stripInternalTags("文字</invoke>更多")).toBe("文字更多");
    expect(stripInternalTags("文字</parameter>更多")).toBe("文字更多");
  });

  it.skip("channel marker <|...|> 形态剥离", () => {
    expect(stripInternalTags("回复<|im_end|>之后")).toBe("回复之后");
    expect(stripInternalTags("<|channel|>analysis<|message|>正文")).toBe("analysis正文");
  });
});

// ── C1：正文字面提到工具【开】标签，绝不吃后续正文（#1308 code review）──
//   旧实现 step 4「未闭合开标签删到段尾」无锚点，匹配 prose 任意位置的
//   工具开标签并把其后整段正文删掉。这与 stream-guard 的 ^ 锚点哲学自相
//   矛盾（stream-guard 保住「正文字面提及」，bridge 侧却破坏它）。
//   修法：孤立的、被正文包夹的单个工具开标签按 token-only 删（与孤立闭合
//   标签对称）；只有真碎片（段首起手，或开标签后紧跟工具协议结构）才截断。
describe.skip("stripInternalTags — 正文字面工具开标签不吃正文 (C1)", () => {
  // invoke / parameter / tool_calls / function_calls × 段首 / 段中 × 跨行。
  // parameter / tool_calls 是高频词，最易误删。
  const TAGS = ["invoke", "parameter", "tool_calls", "function_calls"];

  // 契约（与孤立闭合标签 token-only 对称）：孤立开标签 token 本身被删，
  // 但其后所有正文必须保留（绝不吃正文）。删 token 留下的空白照旧保留，
  // 与现有 "</think>" 用例（"DeepSeek 用  标记结束" 双空格）一致。
  for (const tag of TAGS) {
    it.skip(`段中孤立 <${tag}> + 后跟多行正文：后续正文全保留`, () => {
      const input = `我来解释一下 <${tag}> 是什么标签。\n第二行正文。\n第三行正文。`;
      expect(stripInternalTags(input)).toBe(
        `我来解释一下  是什么标签。\n第二行正文。\n第三行正文。`,
      );
    });

    it.skip(`段中孤立 <${tag}>：同段后续正文保留`, () => {
      const input = `XML 的 <${tag}> 元素用来传参，下面详细说明。`;
      expect(stripInternalTags(input)).toBe(`XML 的  元素用来传参，下面详细说明。`);
    });

    it.skip(`孤立 <${tag}> 跨段：另一段完全保留`, () => {
      const input = `标签 <${tag}> 用来包裹工具调用。\n\n这是另一段完全正文。`;
      expect(stripInternalTags(input)).toBe(
        `标签  用来包裹工具调用。\n\n这是另一段完全正文。`,
      );
    });

    it.skip(`段首起手孤立 <${tag}>（无协议结构）：token-only 删，后文保留`, () => {
      // 段首一个孤立开标签，后面是讲解正文（不是 name= 属性 / 工具协议结构），
      // 不构成真碎片 → token-only 删，后续正文保留。
      // 注意：stripInternalTags 末尾 trim 会去掉删 token 后的前导空白。
      const input = `<${tag}> 是工具协议里的一个标签。`;
      expect(stripInternalTags(input)).toBe(`是工具协议里的一个标签。`);
    });
  }

  // C1 的反面：真工具碎片（开标签起手 + name= 属性）仍必须被剥离。
  it.skip("真碎片：段首 <tool_calls><invoke name=...> 仍从工具标签起丢弃", () => {
    const input = '看这里<tool_calls><invoke name="bash"><parameter name="command">ls -la';
    expect(stripInternalTags(input)).toBe("看这里");
  });

  it.skip("真碎片：孤立开标签但带 name= 属性（协议结构）仍截断到段尾", () => {
    // 单个 <invoke name="bash"> 后跟参数文本，是工具调用数据碎片，应丢弃。
    const input = '执行<invoke name="bash">ls -la\n这看似正文实为参数残留';
    expect(stripInternalTags(input)).toBe("执行");
  });

  it.skip("真碎片：工具开标签后紧跟另一个工具开标签 → 协议结构，截断", () => {
    // <tool_calls> 紧跟 <invoke> 是流式中断的典型碎片特征。
    const input = "前文<tool_calls><invoke>残留参数文本";
    expect(stripInternalTags(input)).toBe("前文");
  });
});

// ── C2：block 行级路径 与 edit_message 段级路径 对同一输入一致 ──
//   block 模式走 StreamCleaner → _processLine → stripInternalTagsLine；
//   edit_message 最终走 _cleanReplyForPlatform → stripInternalTags。
//   同一含「正文字面工具开标签」的输入，两条路径结果必须一致且都不吃正文。
describe.skip("stripInternalTags — block vs edit_message 路径一致性 (C2)", () => {
  // 每条都含字面「正文」以便断言后续正文确实保留。
  const inputs = [
    "我来解释一下 <invoke> 是什么标签。\n第二行正文。\n第三行正文。",
    "XML 的 <parameter> 元素用来传参，这里是后续正文。",
    "标签 <tool_calls> 用来包裹工具调用。\n这是同输入的另一行正文。",
    "讲一下 <function_calls> 这个外层标签，后面跟着正文。",
  ];

  for (const input of inputs) {
    it.skip(`两路径一致且不吃正文：${JSON.stringify(input).slice(0, 28)}…`, () => {
      // edit_message 路径：整段 stripInternalTags。
      const edit = stripInternalTags(input);
      // block 路径：StreamCleaner 行级处理（feed 整段 + flush 尾行）。
      const block = feedAll(new StreamCleaner(), [input]);

      // block 行级把每行用 \n join 回来，stripInternalTags 末尾会 trim；
      // 两者都不吃正文，逐行内容应一致。比较 trim 后结果。
      expect(block.trim()).toBe(edit);
      // 字面标签与后续正文都在。
      expect(edit).toContain("正文");
      expect(block).toContain("正文");
    });
  }
});

describe.skip("stripInternalTags — <t> 时间戳 (#1293)", () => {
  it.skip("行首 <t>05-28 17:13</t> 前缀剥离", () => {
    expect(stripInternalTags("<t>05-28 17:13</t>正文")).toBe("正文");
  });

  it.skip("正文中间 parrot 回来的 <t>", () => {
    expect(stripInternalTags("前面<t>05-28 17:13</t>后面")).toBe("前面后面");
  });

  // I2：旧 TIME_TAG_RE = /<t>[^<]*<\/t>/ 用 [^<]* 匹配任意内容，吃掉正文字面 <t>foo</t>。
  //     收紧到只匹配 MM-DD HH:mm 时间戳形态（timeTag 真实产物）。
  it.skip("正文字面 <t>foo</t> 不被吃（非时间戳形态）", () => {
    expect(stripInternalTags("HTML 里 <t>foo</t> 是个标签")).toBe("HTML 里 <t>foo</t> 是个标签");
  });

  it.skip("正文字面 <t>123</t> 等非时间戳内容保留", () => {
    expect(stripInternalTags("公式 <t>x_t</t> 表示第 t 项")).toBe("公式 <t>x_t</t> 表示第 t 项");
  });

  it.skip("真时间戳带前后正文仍剥离", () => {
    expect(stripInternalTags("现在 <t>12-31 09:05</t> 了")).toBe("现在  了");
  });
});

describe.skip("stripInternalTags — 【绝不吃正文】code fence / 行内 code 保护", () => {
  it.skip("code fence 内的 <think>/</think> 原样保留", () => {
    const input = "看这段：\n```\n<think>这是代码里的字面量</think>\n</think>\n```\n结束";
    expect(stripInternalTags(input)).toBe(input);
  });

  it.skip("code fence 内的工具协议 XML 原样保留", () => {
    const input = '示例：\n```xml\n<tool_calls><invoke name="bash"></invoke></tool_calls>\n```\n讲解';
    expect(stripInternalTags(input)).toBe(input);
  });

  it.skip("行内 backtick code 里的 </think> 原样保留", () => {
    const input = "用 `</think>` 这个标记，后面继续";
    expect(stripInternalTags(input)).toBe(input);
  });

  it.skip("行内 backtick code 里的 <tool_calls> 原样保留", () => {
    const input = "标签 `<tool_calls>` 是工具协议开头";
    expect(stripInternalTags(input)).toBe(input);
  });

  it.skip("混合：fence 内保留 + fence 外裸闭合剥离", () => {
    const input = "</think>开头\n```\n<think>x</think>\n```\n</think>结尾";
    expect(stripInternalTags(input)).toBe("开头\n```\n<think>x</think>\n```\n结尾");
  });
});

describe.skip("stripInternalTags — 多段各含字面标签", () => {
  it.skip("多个裸闭合分散在多段，各段正文都保留", () => {
    const input = "第一段</think>内容\n第二段</think>内容\n第三段正常";
    expect(stripInternalTags(input)).toBe("第一段内容\n第二段内容\n第三段正常");
  });

  it.skip("空字符串 / undefined 安全", () => {
    expect(stripInternalTags("")).toBe("");
    expect(stripInternalTags(undefined)).toBe("");
    expect(stripInternalTags(null)).toBe("");
  });

  it.skip("纯正文不动", () => {
    const input = "这是一段完全正常的回复，没有任何标签。";
    expect(stripInternalTags(input)).toBe(input);
  });
});

// ── StreamCleaner：增量清洗 + 跨 chunk 一致性 ─────────────────

function feedAll(cleaner, deltas) {
  let out = "";
  for (const d of deltas) out += cleaner.feed(d);
  out += cleaner.flushLineBuf();
  return out;
}

describe.skip("StreamCleaner — 一次喂入", () => {
  it.skip("成对 <think> 增量剥离（现有行为不破坏）", () => {
    expect(feedAll(new StreamCleaner(), ["前<think>内心</think>后\n"])).toBe("前后\n");
  });

  it.skip("裸闭合 </think> 增量剥离（#1308）", () => {
    expect(feedAll(new StreamCleaner(), ["</think>正文\n"])).toBe("正文\n");
  });

  it.skip("裸闭合 </think> 在中间", () => {
    expect(feedAll(new StreamCleaner(), ["前面</think>后面\n"])).toBe("前面后面\n");
  });

  it.skip("【关键】字面提到 </think> 不吃前文", () => {
    expect(feedAll(new StreamCleaner(), ["DeepSeek 用 </think> 标记结束\n"]))
      .toBe("DeepSeek 用  标记结束\n");
  });

  it.skip("<t> 时间戳剥离", () => {
    expect(feedAll(new StreamCleaner(), ["<t>05-28 17:13</t>正文\n"])).toBe("正文\n");
  });

  it.skip("工具协议碎片剥离", () => {
    expect(feedAll(new StreamCleaner(), ['看这里<tool_calls><invoke name="bash">\n']))
      .toBe("看这里\n");
  });
});

describe.skip("StreamCleaner — 跨 chunk 一致性（feed 分两次）", () => {
  function singleVsSplit(full, splitAt) {
    const single = feedAll(new StreamCleaner(), [full]);
    const split = feedAll(new StreamCleaner(), [full.slice(0, splitAt), full.slice(splitAt)]);
    return { single, split };
  }

  it.skip("裸闭合 </thi + nk> 切分一致", () => {
    const full = "前面</think>后面\n";
    const at = full.indexOf("</think>") + 4; // 切在 </thi | nk>
    const { single, split } = singleVsSplit(full, at);
    expect(split).toBe(single);
    expect(split).toBe("前面后面\n");
  });

  it.skip("<t> 标签 <t>05-28 | 17:13</t> 切分一致", () => {
    const full = "<t>05-28 17:13</t>正文\n";
    const at = 6; // <t>05- | 28 ...
    const { single, split } = singleVsSplit(full, at);
    expect(split).toBe(single);
    expect(split).toBe("正文\n");
  });

  it.skip("成对 <think> 跨 chunk 一致", () => {
    const full = "前<think>心情</think>后\n";
    const at = full.indexOf("<think>") + 3;
    const { single, split } = singleVsSplit(full, at);
    expect(split).toBe(single);
    expect(split).toBe("前后\n");
  });

  it.skip("行内 backtick `</think>` 跨 chunk 保留", () => {
    const full = "用 `</think>` 标记\n";
    const at = full.indexOf("</think>") + 4;
    const { single, split } = singleVsSplit(full, at);
    expect(split).toBe(single);
    expect(split).toBe("用 `</think>` 标记\n");
  });
});

describe.skip("StreamCleaner — code fence 保护（新增 token）", () => {
  // 行级 token（裸闭合 / 工具协议碎片 / <t> / channel marker）在 fence 内受保护。
  it.skip("fence 内裸闭合 </think> 原样", () => {
    const input = "讲解：\n```\n上一行\n</think>\n```\n完\n";
    expect(feedAll(new StreamCleaner(), [input])).toBe(input);
  });

  it.skip("fence 内工具协议碎片原样", () => {
    const input = '示例：\n```\n<tool_calls><invoke name="bash"></invoke></tool_calls>\n```\n完\n';
    expect(feedAll(new StreamCleaner(), [input])).toBe(input);
  });

  it.skip("fence 内 <t> 原样", () => {
    const input = "看：\n```\n<t>05-28 17:13</t>\n```\n完\n";
    expect(feedAll(new StreamCleaner(), [input])).toBe(input);
  });

  it.skip("行内 backtick `</think>` 原样（单行）", () => {
    expect(feedAll(new StreamCleaner(), ["用 `</think>` 标记\n"])).toBe("用 `</think>` 标记\n");
  });

  // 已知边界（不在本次修复范围、属流式预览既有行为）：
  // StreamCleaner 的两态 _buf 状态机负责「跨行成对内省标签」的增量剥离，
  // 它早于行级 fence 追踪运行，故 fence 内的【成对】<think>…</think> 在
  // block 流式预览中仍会被剥离。最终投递文本走 _cleanReplyForPlatform →
  // stripInternalTags，对 fence 内成对标签是保护的（见下方 stripInternalTags 用例）。
});

// ── _cleanReplyForPlatform / _cleanStreamSnapshot：最终门 ──────

describe.skip("_cleanReplyForPlatform — 复用 stripInternalTags", () => {
  it.skip("裸闭合 </think> 最终清洗", () => {
    expect(__test_cleanReplyForPlatform("</think>正文")).toBe("正文");
  });

  it.skip("工具协议 XML 最终清洗", () => {
    const input = '答案<tool_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></tool_calls>';
    expect(__test_cleanReplyForPlatform(input)).toBe("答案");
  });

  it.skip("<t> 时间戳最终清洗", () => {
    expect(__test_cleanReplyForPlatform("<t>05-28 17:13</t>正文")).toBe("正文");
  });

  it.skip("成对 think/mood 仍清洗", () => {
    expect(__test_cleanReplyForPlatform("<think>x</think><mood>y</mood>正文")).toBe("正文");
  });

  it.skip("字面提到标签的正文不吃前文", () => {
    expect(__test_cleanReplyForPlatform("DeepSeek 用 </think> 标记结束"))
      .toBe("DeepSeek 用  标记结束");
  });
});

describe.skip("_cleanStreamSnapshot — 快照清洗", () => {
  it.skip("裸闭合 </think>", () => {
    expect(__test_cleanStreamSnapshot("</think>正文").text).toBe("正文");
  });

  it.skip("尾部不完整开标签 <think 截断（增量快照）", () => {
    // 流式快照可能停在半个开标签，需要截断不显示
    expect(__test_cleanStreamSnapshot("正文<think").text).toBe("正文");
  });

  it.skip("尾部不完整 <thi 截断", () => {
    expect(__test_cleanStreamSnapshot("正文<thi").text).toBe("正文");
  });

  it.skip("工具协议碎片快照", () => {
    expect(__test_cleanStreamSnapshot('答案<tool_calls><invoke name="bash">').text).toBe("答案");
  });
});

// ── 端到端：真实 delivery 路径不泄漏内部标签 ──────────────────

function makeBridge() {
  const engine = {
    getAgent: vi.fn(() => ({ agentName: "Codia", config: {} })),
    agentName: "Codia",
    codiaHome: os.tmpdir(),
    getBridgeMediaPublicBaseUrl: () => "",
  };
  const hub = { eventBus: { emit: vi.fn() }, subscribe: vi.fn(() => null) };
  return new BridgeManager({ engine, hub });
}

describe.skip("delivery 集成 — block 模式（QQ #1308）", () => {
  it.skip("裸闭合 </think> 不出现在 block 气泡里", async () => {
    const bm = makeBridge();
    const sent = [];
    const adapter = {
      streamingCapabilities: { mode: "block", scopes: ["dm"] },
      sendBlockReply: vi.fn(async (_chatId, text) => { sent.push(text); }),
      sendReply: vi.fn(async (_chatId, text) => { sent.push(text); }),
    };
    const delivery = bm._createStreamDelivery({ adapter, chatId: "c1", isGroup: false, platform: "qq" } as any);

    // 模拟流式：正文 + 裸闭合 </think> + 后续正文
    for (const d of ["第一段回复\n", "</think>", "第二段回复\n"]) delivery.onDelta?.(d, "");
    await delivery.finish("第一段回复\n</think>第二段回复\n");

    const joined = sent.join("\n");
    expect(joined).not.toContain("</think>");
    expect(joined).toContain("第一段回复");
    expect(joined).toContain("第二段回复");
  });

  it.skip("工具协议碎片不出现在 block 气泡里", async () => {
    const bm = makeBridge();
    const sent = [];
    const adapter = {
      streamingCapabilities: { mode: "block", scopes: ["dm"] },
      sendBlockReply: vi.fn(async (_chatId, text) => { sent.push(text); }),
      sendReply: vi.fn(async (_chatId, text) => { sent.push(text); }),
    };
    const delivery = bm._createStreamDelivery({ adapter, chatId: "c1", isGroup: false, platform: "qq" } as any);
    for (const d of ['正文<tool_calls><invoke name="bash">', '<parameter name="command">ls\n']) {
      delivery.onDelta?.(d, "");
    }
    await delivery.finish('正文<tool_calls><invoke name="bash"><parameter name="command">ls\n');
    const joined = sent.join("\n");
    expect(joined).not.toContain("<tool_calls>");
    expect(joined).not.toContain("<invoke");
    expect(joined).toContain("正文");
  });
});

describe.skip("delivery 集成 — edit_message 模式（飞书 #1293）", () => {
  it.skip("最终消息剥离工具协议 XML 与 <t> 时间戳", async () => {
    const bm = makeBridge();
    const updates = [];
    let state = null;
    const adapter = {
      streamingCapabilities: { mode: "edit_message", scopes: ["dm"], minIntervalMs: 0, maxChars: 150000 },
      startStreamReply: vi.fn(async (_c, text) => { state = { messageId: "m1" }; updates.push(text); return state; }),
      updateStreamReply: vi.fn(async (_c, _s, text) => { updates.push(text); }),
      finishStreamReply: vi.fn(async (_c, _s, text) => { updates.push(text); }),
      sendReply: vi.fn(async (_c, text) => { updates.push(text); }),
    };
    const delivery = bm._createStreamDelivery({ adapter, chatId: "c1", isGroup: false, platform: "feishu" } as any);

    const full = '<t>05-28 17:13</t>这是回复<tool_calls><invoke name="bash"><parameter name="command">ls</parameter></invoke></tool_calls>结束';
    delivery.onDelta?.(full, full);
    await delivery.finish(full);

    const last = updates[updates.length - 1];
    expect(last).not.toContain("<t>");
    expect(last).not.toContain("<tool_calls>");
    expect(last).not.toContain("<invoke");
    expect(last).toContain("这是回复");
    expect(last).toContain("结束");
  });
});
