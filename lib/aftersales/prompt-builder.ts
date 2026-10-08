export function buildAfterSalesPrompt(task, config) {
  const caseInfo = task.caseInfo || {};
  const checklist = config?.promptTemplate?.checklist || [];
  const systemRole = config?.promptTemplate?.systemRole
    || "你是产品售后分身，负责整理测试案例并生成专业稳定的出图测试提示词。";

  const summary = [
    `产品：${caseInfo.productName || "未填写"}`,
    `场景：${caseInfo.scene || "未填写"}`,
    `风格：${caseInfo.style || "未填写"}`,
    `尺寸：${caseInfo.size || "未填写"}`,
    `轮次：${caseInfo.rounds || 1}`,
  ].join("\n");

  const userPrompt = [
    "请基于以下售后测试案例，生成适合设计聚焦平台的专业生图提示词。",
    "",
    summary,
    caseInfo.expectations ? `预期：${caseInfo.expectations}` : "",
    caseInfo.negativePrompt ? `负面词：${caseInfo.negativePrompt}` : "",
    caseInfo.notes ? `备注：${caseInfo.notes}` : "",
    caseInfo.rawPrompt ? `客户原始描述：${caseInfo.rawPrompt}` : "",
    checklist.length ? `质检清单：${checklist.join("、")}` : "",
  ].filter(Boolean).join("\n");

  return {
    systemRole,
    userPrompt,
    negativePrompt: caseInfo.negativePrompt || "",
    qualityChecklist: checklist,
    requestPreview: {
      productName: caseInfo.productName || "",
      scene: caseInfo.scene || "",
      style: caseInfo.style || "",
      size: caseInfo.size || "",
      rounds: caseInfo.rounds || 1,
    },
  };
}

export function buildAfterSalesReply(task) {
  const caseInfo = task.caseInfo || {};
  const exec = task.execution || {};
  const lines = [];
  lines.push(`测试任务：${caseInfo.productName || "未命名案例"}`);
  lines.push(`场景：${caseInfo.scene || "未填写"}`);
  lines.push(`风格：${caseInfo.style || "未填写"}`);
  lines.push(`尺寸：${caseInfo.size || "未填写"}`);
  lines.push(`轮次：${caseInfo.rounds || 1}`);

  if (exec.mode === "dry-run") {
    lines.push("当前为骨架演示模式，尚未真正调用设计聚焦平台。");
  } else if (exec.externalTaskId) {
    lines.push(`平台任务号：${exec.externalTaskId}`);
  }

  if (Array.isArray(exec.imageUrls) && exec.imageUrls.length > 0) {
    lines.push(`已产出图片：${exec.imageUrls.length} 张`);
  }

  if (exec.status === "failed" && exec.error) {
    lines.push(`失败原因：${exec.error}`);
  } else {
    lines.push("状态：已完成测试流转。");
  }

  return lines.join("\n");
}
