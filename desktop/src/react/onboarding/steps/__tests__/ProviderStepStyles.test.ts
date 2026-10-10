/**
 * @vitest-environment jsdom
 */

import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../../..');
const cssPath = path.join(ROOT, 'desktop/src/styles.css');

function loadOnboardingStyles() {
  const css = fs.readFileSync(cssPath, 'utf8');
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return css;
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('ProviderStep CSS contract', () => {
  it('styles the custom provider picker instead of falling back to native controls', () => {
    const css = fs.readFileSync(cssPath, 'utf8');

    for (const selector of [
      '.ob-provider-select',
      '.ob-provider-trigger',
      '.ob-provider-menu',
      '.ob-provider-search',
      '.ob-provider-options',
      '.ob-provider-option',
      '.ob-provider-empty',
    ]) {
      expect(css).toContain(selector);
    }
  });

  it('applies dropdown layout rules to the provider picker controls', () => {
    loadOnboardingStyles();
    document.body.innerHTML = `
      <div class="onboarding">
        <div class="onboarding-step active">
          <div class="ob-provider-select">
            <button type="button" class="ob-provider-trigger">
              <span>选择供应商</span>
              <svg viewBox="0 0 24 24"></svg>
            </button>
            <div class="ob-provider-menu">
              <input class="ob-input ob-provider-search" />
              <div class="ob-provider-options">
                <button type="button" class="ob-provider-option">Ollama (本地)</button>
                <button type="button" class="ob-provider-option">OpenAI</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const trigger = document.querySelector('.ob-provider-trigger') as HTMLElement;
    const menu = document.querySelector('.ob-provider-menu') as HTMLElement;
    const options = document.querySelector('.ob-provider-options') as HTMLElement;
    const option = document.querySelector('.ob-provider-option') as HTMLElement;

    expect(getComputedStyle(trigger).display).toBe('flex');
    expect(getComputedStyle(trigger).width).toBe('100%');
    expect(getComputedStyle(trigger).minHeight).toBe('40px');
    expect(getComputedStyle(trigger).textAlign).toBe('left');
    expect(getComputedStyle(menu).position).toBe('absolute');
    expect(getComputedStyle(options).flexDirection).toBe('column');
    expect(getComputedStyle(option).display).toBe('block');
    expect(getComputedStyle(option).textAlign).toBe('left');
  });

  it('keeps the memory toggle label horizontal in the onboarding card', () => {
    loadOnboardingStyles();
    document.body.innerHTML = `
      <div class="onboarding">
        <div class="onboarding-step active">
          <div class="ob-name-form">
            <div class="ob-memory-row">
              <div class="ob-memory-copy">
                <span class="ob-memory-title">Memory System</span>
                <span class="ob-memory-hint">Collect useful context after chats finish.</span>
              </div>
              <div class="ob-memory-toggle">
                <div>
                  <button type="button" class="codia-toggle on"></button>
                  <span class="codia-toggle-label">Memory System</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const toggleWrap = document.querySelector('.ob-memory-toggle') as HTMLElement;
    const toggleInner = document.querySelector('.ob-memory-toggle > div') as HTMLElement;
    const label = document.querySelector('.ob-memory-toggle .codia-toggle-label') as HTMLElement;

    expect(getComputedStyle(toggleWrap).flexShrink).toBe('0');
    expect(getComputedStyle(toggleInner).flexDirection).toBe('row');
    expect(getComputedStyle(toggleInner).flexWrap).toBe('nowrap');
    expect(getComputedStyle(label).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(label).writingMode).toBe('horizontal-tb');
  });

  it('keeps first-run provider fields and connection status from crowding each other', () => {
    loadOnboardingStyles();
    document.body.innerHTML = `
      <div class="onboarding">
        <div class="onboarding-step active">
          <div class="custom-provider-fields">
            <div class="custom-field"><input class="ob-input" /></div>
            <div class="custom-field"><button type="button" class="ob-input">OpenAI Compatible</button></div>
          </div>
          <div class="ob-key-row">
            <input class="ob-input" />
            <button type="button" class="ob-key-toggle"></button>
          </div>
          <div class="ob-test-row">
            <button type="button" class="ob-test-btn">Test Connection</button>
            <span class="ob-status error">HTTP 401: Unauthorized from provider gateway</span>
          </div>
        </div>
      </div>
    `;

    const fields = document.querySelector('.custom-provider-fields') as HTMLElement;
    const keyToggle = document.querySelector('.ob-key-toggle') as HTMLElement;
    const testRow = document.querySelector('.ob-test-row') as HTMLElement;
    const testButton = document.querySelector('.ob-test-btn') as HTMLElement;
    const status = document.querySelector('.ob-status') as HTMLElement;

    expect(getComputedStyle(fields).display).toBe('grid');
    expect(getComputedStyle(fields).gridTemplateColumns).not.toBe('');
    expect(getComputedStyle(keyToggle).width).toBe('40px');
    expect(getComputedStyle(testRow).flexWrap).toBe('wrap');
    expect(getComputedStyle(testButton).flexGrow).toBe('0');
    expect(getComputedStyle(status).overflowWrap).toBe('anywhere');
    expect(getComputedStyle(status).minWidth).toBe('0px');
  });
});
