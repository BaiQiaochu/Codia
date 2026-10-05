import { describe, expect, it } from "vitest";

import {
  isToolProtocolFragment,
  stripToolProtocolTagsFromProse,
} from "../lib/tool-protocol-sanitizer.ts";

describe("runtime tool protocol sanitizer", () => {
  it("recognizes XML, namespaced, full-width, and channel marker protocol fragments", () => {
    expect(isToolProtocolFragment('<tool_calls><invoke name="bash"><parameter name="command">pwd')).toBe(true);
    expect(isToolProtocolFragment('<antml:function_calls><antml:invoke name="read">')).toBe(true);
    expect(isToolProtocolFragment('<dsml:tool_call name="browser.open"><dsml:parameter name="url">')).toBe(true);
    expect(isToolProtocolFragment('＜tool_calls＞＜invoke name＝＂bash＂＞pwd')).toBe(true);
    expect(isToolProtocolFragment('＜dsml：tool_call name＝＂read＂＞')).toBe(true);
    expect(isToolProtocolFragment("<|channel|>analysis<|message|>")).toBe(true);
  });

  it("does not classify prose that only mentions a tool tag as a protocol fragment", () => {
    expect(isToolProtocolFragment("正文里提到 <tool_call> 标签时，后续内容也应继续显示。")).toBe(false);
    expect(isToolProtocolFragment("<tool_calls> 是工具协议里的一个标签。")).toBe(false);
    expect(isToolProtocolFragment("`<tool_calls>` 是一个例子。")).toBe(false);
  });

  it("strips tool protocol tags while preserving surrounding prose", () => {
    expect(
      stripToolProtocolTagsFromProse('正文<dsml:tool_call name="bash"><parameter name="command">pwd</parameter></dsml:tool_call>结尾'),
    ).toBe("正文结尾");

    expect(
      stripToolProtocolTagsFromProse('正文＜tool_calls＞＜invoke name＝＂bash＂＞pwd＜/invoke＞＜/tool_calls＞结尾'),
    ).toBe("正文结尾");

    expect(stripToolProtocolTagsFromProse("XML 的 <tool_calls> 元素用来传参。"))
      .toBe("XML 的  元素用来传参。");
  });

  it("truncates true streamed protocol fragments from the first structural tool tag", () => {
    expect(stripToolProtocolTagsFromProse('前文<tool_calls><invoke name="bash">残留参数')).toBe("前文");
    expect(stripToolProtocolTagsFromProse('前文＜invoke name＝＂bash＂＞残留参数\n下一行也属于残留')).toBe("前文");
  });
});
