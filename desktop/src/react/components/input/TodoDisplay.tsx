import { useState } from 'react';
import styles from './InputArea.module.css';
import { useI18n } from '../../hooks/use-i18n';
import type { TodoItem, TodoStatus } from '../../types';
import { buildTodoTree, todoTreeDisplayText, type TodoTreeNode } from '../../utils/todo-tree';

/**
 * TodoDisplay — 对标 Claude Code TodoWrite 的三态渲染组件
 *
 * - pending: ○ 灰色默认
 * - in_progress: ⟳ accent 色，显示 activeForm
 * - completed: ✓ success 色 + 删除线
 *
 * TodoItem 严格 3 字段，不加索引签名或透传式消费。
 */

const STATUS_ICON: Record<TodoStatus, string> = {
  pending: '○',
  in_progress: '⟳',
  completed: '✓',
};

const STATUS_CLASS: Record<TodoStatus, string> = {
  pending: 'todo-bar-pending',
  in_progress: 'todo-bar-in-progress',
  completed: 'todo-bar-done',
};

/**
 * 展示文案：in_progress 用 activeForm，否则用 content
 * 若 activeForm 缺失（旧数据降级），fallback 到 content
 */
function displayText(todo: TodoItem): string {
  if (todo.status === 'in_progress' && todo.activeForm) return todo.activeForm;
  return todo.content || todo.activeForm || '';
}

/**
 * 折叠态预览：优先第一个 in_progress，否则第一个 pending，全完成显示 allDone 文案
 */
function pickPreview(todos: TodoItem[], allDoneText: string): string {
  const inProgress = todos.find((t) => t.status === 'in_progress');
  if (inProgress) return displayText(inProgress);
  const pending = todos.find((t) => t.status === 'pending');
  if (pending) return displayText(pending);
  return allDoneText;
}

function TodoTreeNodeView({ node }: { node: TodoTreeNode }) {
  const statusClass = styles[STATUS_CLASS[node.todo.status]] ?? '';
  const text = todoTreeDisplayText(node);
  return (
    <div
      data-testid="todo-tree-node"
      className={styles['todo-tree-node']}
    >
      <div className={`${styles['todo-bar-item']}${statusClass ? ` ${statusClass}` : ''}`}>
        <span className={styles['todo-bar-check']}>{STATUS_ICON[node.todo.status]}</span>
        <span>{text}</span>
      </div>
      {node.children.length > 0 && (
        <div data-testid="todo-tree-children" className={styles['todo-tree-children']}>
          {node.children.map((child) => (
            <TodoTreeNodeView key={child.key} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TodoDisplay({
  todos,
  onCompleteAll,
  completing = false,
}: {
  todos: TodoItem[];
  onCompleteAll?: () => void;
  completing?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  if (!todos || todos.length === 0) return null;

  const completedCount = todos.filter((t) => t.status === 'completed').length;
  const preview = pickPreview(todos, t('common.allDone'));
  const todoTree = buildTodoTree(todos);

  return (
    <div className={`${styles['todo-bar']}${open ? ` ${styles['todo-bar-open']}` : ''}`}>
      {open && (
        <div className={styles['todo-bar-list']} data-testid="todo-tree">
          {todoTree.map((node) => (
            <TodoTreeNodeView key={node.key} node={node} />
          ))}
          {onCompleteAll && (
            <button
              type="button"
              className={styles['todo-bar-complete-row']}
              disabled={completing}
              onClick={(event) => {
                event.stopPropagation();
                onCompleteAll();
              }}
            >
              <span className={styles['todo-bar-complete-icon']} aria-hidden="true">✓</span>
              <span>{t('common.markAllComplete')}</span>
            </button>
          )}
        </div>
      )}
      <button type="button" className={styles['todo-bar-trigger']} onClick={() => setOpen(!open)}>
        <span className={styles['todo-bar-icon']}>☑</span>
        <span className={styles['todo-bar-preview']}>{preview}</span>
        <span className={styles['todo-bar-count']}>
          {completedCount}/{todos.length}
        </span>
      </button>
    </div>
  );
}
