// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('SkillViewerOverlay security', () => {
  beforeEach(async () => {
    const { useStore } = await import('../../stores');
    useStore.setState({
      skillViewerData: {
        name: 'Unsafe skill',
        baseDir: 'C:/skills/unsafe',
        filePath: 'C:/skills/unsafe/SKILL.md',
        installed: true,
      },
    });
    (globalThis as typeof globalThis & { t?: (key: string) => string }).t = (key: string) => key;
    (window as unknown as { platform?: unknown }).platform = {
      listSkillFiles: vi.fn(async () => ([{ name: 'SKILL.md', path: 'C:/skills/unsafe/SKILL.md' }])),
      readSkillFile: vi.fn(async () => [
        '---',
        'name: unsafe',
        'description: unsafe description',
        '---',
        '# Unsafe',
        '<script>window.__xss = true</script>',
        '<img src=x onerror="window.__xss = true">',
        '<a href="javascript:alert(1)" onclick="window.__xss = true">bad link</a>',
      ].join('\n')),
    };
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    delete (window as unknown as { platform?: unknown }).platform;
    delete (globalThis as typeof globalThis & { t?: unknown }).t;
  });

  it('sanitizes markdown preview HTML before injecting into the DOM', async () => {
    const { SkillViewerOverlay } = await import('../../components/SkillViewerOverlay');
    const { container } = render(<SkillViewerOverlay />);

    await waitFor(() => expect(screen.getByText('Unsafe')).toBeInTheDocument());

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
    expect(container.innerHTML).not.toContain('onclick=');
    expect(container.innerHTML).not.toContain('onerror=');
  });
});
