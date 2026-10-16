// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import { consumeWorkflowTemplateRequest, requestWorkflowTemplate } from '../../utils/workflow-template-request';

describe('workflow template request workspace scope', () => {
  afterEach(() => {
    useStore.setState({ selectedFolder: null, selectedWorkspaceMountId: null, deskWorkspaceMountId: null, deskBasePath: '', homeFolder: null });
  });

  it('follows the same active desk as the canvas after chat clears the folder selection', () => {
    useStore.setState({
      homeFolder: '/home-workspace', selectedFolder: null, selectedWorkspaceMountId: null,
      deskWorkspaceMountId: null, deskBasePath: '/project-workspace',
    });
    requestWorkflowTemplate('Project-specific template');
    useStore.setState({ deskBasePath: '/home-workspace' });
    expect(consumeWorkflowTemplateRequest()).toBeNull();
    useStore.setState({ deskBasePath: '/project-workspace' });
    expect(consumeWorkflowTemplateRequest()).toBe('Project-specific template');
    expect(consumeWorkflowTemplateRequest()).toBeNull();
  });
});
