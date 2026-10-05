// @ts-nocheck
import { describe, it, expect } from 'vitest';
import {
  BLOCK_EXTRACTORS,
  extractBlocks,
  resolveMediaGenerationBlocks,
  resolveMediaGenerationBlocksWithDeferredResults,
} from '../server/block-extractors.js';

// ─── stage_files ─────────────────────────────────────────────────────────────

describe('stage_files', () => {
  const extractor = BLOCK_EXTRACTORS.stage_files;

  it('multi-file: returns one block per file', () => {
    const details = {
      files: [
        { filePath: '/a/foo.txt', label: 'foo', ext: 'txt' },
        { filePath: '/a/bar.js', label: 'bar', ext: 'js' },
      ],
    };
    const result = extractor(details);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'file', filePath: '/a/foo.txt', label: 'foo', ext: 'txt' });
    expect(result[1]).toEqual({ type: 'file', filePath: '/a/bar.js', label: 'bar', ext: 'js' });
  });

  it('single-file fallback: uses filePath/label/ext when files is empty', () => {
    const details = { filePath: '/a/readme.md', label: 'readme', ext: 'md' };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'file', filePath: '/a/readme.md', label: 'readme', ext: 'md' });
  });

  it('defaults ext to empty string when missing', () => {
    const details = { filePath: '/a/file', label: 'file' };
    const result = extractor(details);
    expect(result[0].ext).toBe('');
  });

  it('restores one file block per delivered SessionFile', () => {
    const details = {
      files: [
        {
          fileId: 'sf_cover',
          filePath: '/cache/cover.png',
          label: 'cover.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          size: 5,
          storageKind: 'external',
          status: 'available',
        },
        {
          fileId: 'sf_alt',
          filePath: '/cache/alt.png',
          label: 'alt.png',
          ext: 'png',
          mime: 'image/png',
          kind: 'image',
          size: 3,
          storageKind: 'external',
          status: 'available',
        },
      ],
    };
    const result = extractor(details);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'file',
      fileId: 'sf_cover',
      filePath: '/cache/cover.png',
      label: 'cover.png',
      mime: 'image/png',
      kind: 'image',
      size: 5,
      storageKind: 'external',
      status: 'available',
    });
    expect(result[1]).toMatchObject({
      type: 'file',
      fileId: 'sf_alt',
      filePath: '/cache/alt.png',
      label: 'alt.png',
      mime: 'image/png',
      kind: 'image',
      size: 3,
      storageKind: 'external',
      status: 'available',
    });
  });

  it('empty details: returns empty array', () => {
    const result = extractor({});
    expect(result).toEqual([]);
  });
});

// ─── present_files alias ─────────────────────────────────────────────────────

describe('present_files', () => {
  it('is the same function reference as stage_files', () => {
    expect(BLOCK_EXTRACTORS.present_files).toBe(BLOCK_EXTRACTORS.stage_files);
  });

  it('produces identical output to stage_files', () => {
    const details = { filePath: '/a/x.py', label: 'x', ext: 'py' };
    expect(BLOCK_EXTRACTORS.present_files(details)).toEqual(BLOCK_EXTRACTORS.stage_files(details));
  });
});

// ─── create_artifact ─────────────────────────────────────────────────────────

describe('create_artifact', () => {
  const extractor = BLOCK_EXTRACTORS.create_artifact;

  it('normal: returns artifact block with all fields', () => {
    const details = {
      content: 'console.log("hi")',
      artifactId: 'art-1',
      type: 'code',
      title: 'Hello',
      language: 'javascript',
    };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'artifact',
      artifactId: 'art-1',
      artifactType: 'code',
      title: 'Hello',
      content: 'console.log("hi")',
      language: 'javascript',
    });
  });

  it('no content: returns null (extractBlocks treats as empty)', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ artifactId: 'x' })).toBeNull();
  });
});

// ─── browser ─────────────────────────────────────────────────────────────────

describe('browser', () => {
  const extractor = BLOCK_EXTRACTORS.browser;

  const makeToolResult = (data, mimeType) => ({
    content: [{ type: 'image', data, mimeType }],
  });

  it('screenshot with image data: returns screenshot block', () => {
    const toolResult = makeToolResult('base64data==', 'image/png');
    const result = extractor({ action: 'screenshot' }, toolResult);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'screenshot',
      base64: 'base64data==',
      mimeType: 'image/png',
    });
  });

  it('screenshot without mimeType: defaults to image/jpeg', () => {
    const toolResult = { content: [{ type: 'image', data: 'abc' }] };
    const result = extractor({ action: 'screenshot' }, toolResult);
    expect(result[0].mimeType).toBe('image/jpeg');
  });

  it('non-screenshot action: returns null', () => {
    const toolResult = makeToolResult('base64data==', 'image/png');
    expect(extractor({ action: 'click' }, toolResult)).toBeNull();
    expect(extractor({}, toolResult)).toBeNull();
  });

  it('screenshot but no image block in content: returns null', () => {
    const toolResult = { content: [{ type: 'text', text: 'done' }] };
    expect(extractor({ action: 'screenshot' }, toolResult)).toBeNull();
  });

  it('screenshot without image block uses details thumbnail fallback', () => {
    const toolResult = { content: [{ type: 'text', text: 'done' }] };
    const result = extractor({ action: 'screenshot', thumbnail: 'thumb123', mimeType: 'image/webp' }, toolResult);
    expect(result).toEqual([{
      type: 'screenshot',
      base64: 'thumb123',
      mimeType: 'image/webp',
    }]);
  });

  it('screenshot with registered session file returns a file block', () => {
    const result = extractor({
      action: 'screenshot',
      screenshotFile: {
        fileId: 'sf_browser_shot',
        filePath: '/tmp/browser-screenshot.png',
        label: 'browser-screenshot.png',
        ext: 'png',
        mime: 'image/png',
        kind: 'image',
        storageKind: 'managed_cache',
        status: 'available',
      },
    }, { content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] });

    expect(result).toEqual([{
      type: 'file',
      fileId: 'sf_browser_shot',
      filePath: '/tmp/browser-screenshot.png',
      label: 'browser-screenshot.png',
      ext: 'png',
      mime: 'image/png',
      kind: 'image',
      storageKind: 'managed_cache',
      status: 'available',
    }]);
  });

  it('screenshot but image block has no data: returns null', () => {
    const toolResult = { content: [{ type: 'image' }] };
    expect(extractor({ action: 'screenshot' }, toolResult)).toBeNull();
  });

  it('screenshot but toolResult is null: returns null', () => {
    expect(extractor({ action: 'screenshot' }, null)).toBeNull();
  });
});

// ─── install_skill ────────────────────────────────────────────────────────────

describe('install_skill', () => {
  const extractor = BLOCK_EXTRACTORS.install_skill;

  it('normal: returns skill block', () => {
    const details = { skillName: 'my-skill', skillFilePath: '/skills/my-skill.js' };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'skill',
      skillName: 'my-skill',
      skillFilePath: '/skills/my-skill.js',
    });
  });

  it('skillFilePath defaults to empty string when missing', () => {
    const result = extractor({ skillName: 'foo' });
    expect(result[0].skillFilePath).toBe('');
  });

  it('no skillName: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ skillFilePath: '/x' })).toBeNull();
  });
});

// ─── cron ─────────────────────────────────────────────────────────────────────

describe('cron', () => {
  const extractor = BLOCK_EXTRACTORS.cron;

  const jobData = { expression: '0 9 * * *', command: 'remind' };

  it('with jobData and confirmed true: status is approved', () => {
    const result = extractor({ jobData, confirmed: true });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('suggestion_card');
    expect(result[0].kind).toBe('automation_draft');
    expect(result[0].status).toBe('approved');
    expect(result[0].detail.jobData).toBe(jobData);
    expect(result[0].confirmId).toBe('');
  });

  it('with jobData and confirmed undefined: status is approved', () => {
    const result = extractor({ jobData });
    expect(result[0].status).toBe('approved');
  });

  it('confirmed false: status is rejected', () => {
    const result = extractor({ jobData, confirmed: false });
    expect(result[0].status).toBe('rejected');
  });

  it('no jobData: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ confirmed: true })).toBeNull();
  });
});

describe('automation', () => {
  const extractor = BLOCK_EXTRACTORS.automation;

  it('returns a pending automation suggestion card', () => {
    const jobData = { type: 'cron', schedule: '0 9 * * *', prompt: 'daily report' };
    const result = extractor({
      action: 'pending_update',
      operation: 'update',
      confirmId: 'confirm-1',
      jobData,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'suggestion_card',
      kind: 'automation_draft',
      confirmId: 'confirm-1',
      operation: 'update',
      status: 'pending',
      detail: {
        kind: 'automation_draft',
        operation: 'update',
        jobData,
      },
    });
  });
});

// ─── update_settings ─────────────────────────────────────────────────────────

describe('update_settings', () => {
  const extractor = BLOCK_EXTRACTORS.update_settings;

  it('with settingsUpdate returns a settings_update block', () => {
    const update = { theme: 'dark', language: 'zh' };
    expect(extractor({ settingsUpdate: update })).toEqual([{
      type: 'settings_update',
      update,
    }]);
  });

  it('with settingKey and all fields: returns settings_confirm block', () => {
    const details = {
      settingKey: 'theme',
      cardType: 'select',
      currentValue: 'light',
      proposedValue: 'dark',
      label: 'Theme',
    };
    const result = extractor(details);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'settings_confirm',
      confirmId: '',
      settingKey: 'theme',
      cardType: 'select',
      currentValue: 'light',
      proposedValue: 'dark',
      label: 'Theme',
      status: 'confirmed',
    });
  });

  it('defaults cardType to list, currentValue/proposedValue to empty string', () => {
    const result = extractor({ settingKey: 'lang' });
    expect(result[0].cardType).toBe('list');
    expect(result[0].currentValue).toBe('');
    expect(result[0].proposedValue).toBe('');
  });

  it('label falls back to settingKey when label is not provided', () => {
    const result = extractor({ settingKey: 'lang' });
    expect(result[0].label).toBe('lang');
  });

  it('confirmed false: status is rejected', () => {
    const result = extractor({ settingKey: 'theme', confirmed: false });
    expect(result[0].status).toBe('rejected');
  });

  it('no settingKey: returns null', () => {
    expect(extractor({})).toBeNull();
    expect(extractor({ cardType: 'list' })).toBeNull();
  });
});

describe('workflow', () => {
  it('returns an inline workflow summary block', () => {
    expect(extractBlocks('workflow', {
      taskId: 'wf-1',
      workflow: '构建流程',
      streamStatus: 'done',
      summary: '完成',
      startedAt: 100,
      finishedAt: 200,
    })).toEqual([{
      type: 'workflow',
      taskId: 'wf-1',
      taskTitle: '构建流程',
      streamStatus: 'done',
      summary: '完成',
      startedAt: 100,
      finishedAt: 200,
    }]);
  });

  it('requires taskId', () => {
    expect(extractBlocks('workflow', { workflow: 'x' })).toEqual([]);
  });
});

describe('media generation blocks', () => {
  it('extracts image generation tasks without duplicating image-gen plugin cards', () => {
    const blocks = extractBlocks('image-gen_generate-image', {
      mediaGeneration: {
        kind: 'image',
        batchId: 'batch-1',
        prompt: 'city',
        tasks: ['task-1', { taskId: 'task-2' }],
      },
      card: { pluginId: 'image-gen', route: '/image-gen' },
    });

    expect(blocks).toEqual([
      { type: 'media_generation', taskId: 'task-1', kind: 'image', batchId: 'batch-1', prompt: 'city', status: 'pending' },
      { type: 'media_generation', taskId: 'task-2', kind: 'image', batchId: 'batch-1', prompt: 'city', status: 'pending' },
    ]);
  });

  it('accepts media plugin aliases for image and video generation tasks', () => {
    expect(extractBlocks('media_generate-image', {
      mediaGeneration: {
        kind: 'image',
        prompt: 'city',
        tasks: ['task-image'],
      },
    })).toEqual([
      { type: 'media_generation', taskId: 'task-image', kind: 'image', batchId: undefined, prompt: 'city', status: 'pending' },
    ]);

    expect(extractBlocks('media_generate-video', {
      mediaGeneration: {
        kind: 'video',
        prompt: 'city motion',
        tasks: ['task-video'],
      },
    })).toEqual([
      { type: 'media_generation', taskId: 'task-video', kind: 'video', batchId: undefined, prompt: 'city motion', status: 'pending' },
    ]);
  });

  it('replaces completed media generation tasks with session file blocks', () => {
    const blocks = resolveMediaGenerationBlocks([
      { type: 'media_generation', taskId: 'task-1', kind: 'image', status: 'pending' },
    ], new Map([[
      'task-1',
      {
        taskId: 'task-1',
        status: 'success',
        result: {
          sessionFiles: [{
            fileId: 'sf-1',
            filePath: '/tmp/result.png',
            label: 'result.png',
            ext: 'png',
            mime: 'image/png',
            kind: 'image',
          }],
        },
      },
    ]]));

    expect(blocks).toEqual([{
      type: 'file',
      replacesTaskId: 'task-1',
      fileId: 'sf-1',
      filePath: '/tmp/result.png',
      label: 'result.png',
      ext: 'png',
      mime: 'image/png',
      kind: 'image',
    }]);
  });

  it('replaces completed media generation tasks when result only has files', () => {
    const blocks = resolveMediaGenerationBlocks([
      { type: 'media_generation', taskId: 'task-files', kind: 'image', status: 'pending' },
    ], new Map([[
      'task-files',
      {
        taskId: 'task-files',
        status: 'success',
        result: {
          files: ['E:/generated/fallback.png'],
        },
      },
    ]]));

    expect(blocks).toEqual([{
      type: 'file',
      replacesTaskId: 'task-files',
      filePath: 'E:/generated/fallback.png',
      label: 'fallback.png',
      ext: 'png',
    }]);
  });

  it('resolves deferred media generation results while preserving channel sessionPath', () => {
    const blocks = resolveMediaGenerationBlocksWithDeferredResults([
      { type: 'media_generation', taskId: 'task-channel-image', kind: 'image', status: 'pending', sessionPath: '/sessions/channel-phone.jsonl' },
    ], {
      query: (taskId) => taskId === 'task-channel-image'
        ? {
            status: 'resolved',
            meta: { type: 'image-generation' },
            result: {
              sessionFiles: [{
                id: 'sf-channel-image',
                filePath: 'E:/generated/channel.png',
                label: 'channel.png',
                ext: 'png',
                mime: 'image/png',
                kind: 'image',
              }],
            },
          }
        : null,
    });

    expect(blocks).toEqual([{
      type: 'file',
      replacesTaskId: 'task-channel-image',
      fileId: 'sf-channel-image',
      filePath: 'E:/generated/channel.png',
      label: 'channel.png',
      ext: 'png',
      mime: 'image/png',
      kind: 'image',
      sessionPath: '/sessions/channel-phone.jsonl',
    }]);
  });
});

// ─── subagent ─────────────────────────────────────────────────────────────────

describe('subagent', () => {
  it("subagent: 正常", () => {
    const blocks = extractBlocks("subagent", {
      taskId: "t1",
      task: "任务：整理桌面\n\n请独立完成",
      taskTitle: "任务：整理桌面",
      agentId: "gsap",
      agentName: "G-SAP",
      sessionPath: "/s/t.jsonl",
      streamStatus: "running",
    });
    expect(blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "t1",
      taskTitle: "任务：整理桌面",
      requestedAgentId: "gsap",
      requestedAgentName: "G-SAP",
      streamKey: "/s/t.jsonl",
      streamStatus: "running",
    });
  });

  it("subagent: 优先读取显式 executor metadata", () => {
    const blocks = extractBlocks("subagent", {
      taskId: "t1",
      task: "任务：do stuff\n\n详细要求",
      taskTitle: "任务：do stuff",
      agentId: "gsap",
      agentName: "G-SAP",
      executorAgentId: "butter",
      executorAgentNameSnapshot: "butter",
      sessionPath: "/s/t.jsonl",
      streamStatus: "running",
    });
    expect(blocks[0]).toMatchObject({
      type: "subagent",
      taskId: "t1",
      taskTitle: "任务：do stuff",
      agentId: "butter",
      agentName: "butter",
      streamKey: "/s/t.jsonl",
      streamStatus: "running",
    });
  });

  it("subagent: done 状态", () => {
    const blocks = extractBlocks("subagent", {
      taskId: "t2",
      task: "任务：done task\n\n详细要求",
      taskTitle: "任务：done task",
      sessionPath: "/s/t2.jsonl",
      streamStatus: "done",
      summary: "结果摘要",
    });
    expect(blocks[0]).toMatchObject({ type: "subagent", taskTitle: "任务：done task", streamStatus: "done", summary: "结果摘要" });
  });

  it("subagent: 无 taskId 返回空", () => {
    expect(extractBlocks("subagent", {})).toEqual([]);
  });

  it("subagent: 最小字段", () => {
    const blocks = extractBlocks("subagent", { taskId: "t3" });
    expect(blocks[0]).toMatchObject({ type: "subagent", taskId: "t3", task: "", taskTitle: "", agentId: null, streamKey: "", streamStatus: "running" });
  });
});

// ─── plugin card extraction ───────────────────────────────────────────────────

describe('extractBlocks: plugin card extraction', () => {
  it('details.card with pluginId produces a plugin_card block', () => {
    const details = { card: { pluginId: 'fm', route: '/k', title: 'Chart' } };
    const blocks = extractBlocks('unknown_tool', details);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'plugin_card',
      card: { pluginId: 'fm', route: '/k', title: 'Chart', type: 'iframe' },
    });
  });

  it('preserves existing card type when specified', () => {
    const details = { card: { pluginId: 'fm', type: 'native', route: '/x' } };
    const blocks = extractBlocks('unknown_tool', details);
    expect(blocks[0].card.type).toBe('native');
  });

  it('unknown tool with no card: returns empty array', () => {
    const blocks = extractBlocks('nonexistent_tool', {});
    expect(blocks).toEqual([]);
  });

  it('unknown tool with null details: returns empty array', () => {
    const blocks = extractBlocks('nonexistent_tool', null);
    expect(blocks).toEqual([]);
  });
});

// ─── coexistence: tool-specific block + plugin card ───────────────────────────

describe('extractBlocks: tool block + plugin card coexistence', () => {
  it('stage_files details with a card: returns file blocks AND plugin_card', () => {
    const details = {
      files: [{ filePath: '/a/doc.pdf', label: 'doc', ext: 'pdf' }],
      card: { pluginId: 'viewer', route: '/view', type: 'iframe' },
    };
    const blocks = extractBlocks('stage_files', details);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('file');
    expect(blocks[1].type).toBe('plugin_card');
  });

  it('install_skill details with a card: returns skill block AND plugin_card', () => {
    const details = {
      skillName: 'my-skill',
      card: { pluginId: 'skill-ui', route: '/s' },
    };
    const blocks = extractBlocks('install_skill', details);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('skill');
    expect(blocks[1].type).toBe('plugin_card');
  });
});

describe('show_card block extraction', () => {
  it('extracts an interactive_card block from show_card details', () => {
    const code = '<svg viewBox="0 0 100 40"><text x="10" y="20">G-SAP</text></svg>';
    const blocks = extractBlocks('show_card', {
      cardId: 'c_123',
      title: 'system_flow',
      code,
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'interactive_card',
      cardId: 'c_123',
      title: 'system_flow',
      code,
    });
  });

  it('ignores show_card results without code', () => {
    expect(extractBlocks('show_card', { cardId: 'c_123', title: 'empty' })).toEqual([]);
  });
});
