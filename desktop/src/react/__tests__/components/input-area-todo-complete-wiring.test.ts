import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('session todo completion wiring', () => {
  it('posts to the todo completion route from the right workspace card', () => {
    const actionsSource = fs.readFileSync(path.resolve(__dirname, '../../stores/session-actions.ts'), 'utf-8');
    const cardSource = fs.readFileSync(path.resolve(__dirname, '../../components/right-workspace/SessionTodoCard.tsx'), 'utf-8');
    const todoDisplaySource = fs.readFileSync(path.resolve(__dirname, '../../components/input/TodoDisplay.tsx'), 'utf-8');

    expect(actionsSource).toContain('export async function completeSessionTodos');
    expect(actionsSource).toContain('/api/sessions/todos/complete');
    expect(actionsSource).toContain('sessionScopedKey(state as Record<string, any>, sessionPath)');
    expect(actionsSource).toContain('body: JSON.stringify({');
    expect(actionsSource).toContain('path: sessionPath');
    expect(actionsSource).toContain('sessionKey !== sessionPath ? { sessionId: sessionKey } : {}');
    expect(actionsSource).toContain('setSessionTodosForPath(sessionPath, [])');
    expect(actionsSource).toContain('bumpTodosLiveVersion(sessionPath)');

    expect(cardSource).toContain("import { completeSessionTodos } from '../../stores/session-actions'");
    expect(cardSource).toContain('async function handleCompleteAll()');
    expect(cardSource).toContain('await completeSessionTodos(sessionPath)');
    expect(cardSource).toContain('disabled={actionDisabled}');

    expect(todoDisplaySource).toContain('onCompleteAll?: () => void');
    expect(todoDisplaySource).toContain('completing?: boolean');
  });
});
