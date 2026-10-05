import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('interactive card UI integration', () => {
  it('registers interactive_card blocks and loads iframe URLs with auth token query', () => {
    const assistant = read('desktop/src/react/components/chat/AssistantMessage.tsx');
    const card = read('desktop/src/react/components/chat/InteractiveCard.tsx');

    expect(assistant).toContain("BLOCK_RENDERERS.interactive_card = InteractiveCard");
    expect(card).toContain("gsapUrl(`/api/cards/${encodeURIComponent(cardId)}`, { includeTokenQuery: true })");
    expect(card).toContain("gsap.card-resize");
    expect(card).toContain("gsap.card-ping");
  });

  it('hides only card infrastructure tools from tool groups', () => {
    const groupSource = read('desktop/src/react/components/chat/ToolGroupBlock.tsx');
    const visibilitySource = read('desktop/src/react/utils/tool-call-visibility.ts');

    expect(groupSource).toContain("rawTools.filter(t => !isToolCallHiddenFromProcessUi(t))");
    expect(visibilitySource).toContain("'hana_card_guide'");
    expect(visibilitySource).toContain("'show_card'");
    expect(visibilitySource).toContain("'media_generate-image'");
    expect(visibilitySource).toContain("'workflow'");
  });
});
