import type { TodoItem } from '../types';

export interface TodoTreeNode {
  todo: TodoItem;
  children: TodoTreeNode[];
  key: string;
  depth: number;
  label: string;
  activeLabel: string;
}

function cleanTaskLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed
    .replace(/^(?:[-*+]\s+)?(?:\d+(?:\.\d+)*(?:[.)])?\s+)/, '')
    .trim();
}

function explicitId(todo: TodoItem, index: number): string {
  return typeof todo.id === 'string' && todo.id.trim() ? todo.id.trim() : `todo-${index}`;
}

function indentationDepth(text: string): number {
  const match = /^(\s+)/.exec(text);
  if (!match) return 0;
  const spaces = match[1].replace(/\t/g, '  ').length;
  return Math.floor(spaces / 2);
}

function numberedDepth(text: string): number {
  const match = /^\s*(?:[-*+]\s+)?(\d+(?:\.\d+)+)[.)]?\s+/.exec(text);
  if (!match) return 0;
  return Math.max(0, match[1].split('.').length - 1);
}

function inferredDepth(todo: TodoItem): number {
  const contentDepth = Math.max(indentationDepth(todo.content || ''), numberedDepth(todo.content || ''));
  const activeDepth = Math.max(indentationDepth(todo.activeForm || ''), numberedDepth(todo.activeForm || ''));
  return Math.max(contentDepth, activeDepth);
}

function makeNode(todo: TodoItem, index: number, depth = 0): TodoTreeNode {
  return {
    todo,
    children: [],
    key: explicitId(todo, index),
    depth,
    label: cleanTaskLabel(todo.content || todo.activeForm || ''),
    activeLabel: cleanTaskLabel(todo.activeForm || todo.content || ''),
  };
}

function hasExplicitParents(todos: TodoItem[]): boolean {
  return todos.some((todo) => typeof todo.parentId === 'string' && todo.parentId.trim().length > 0);
}

function buildExplicitTree(todos: TodoItem[]): TodoTreeNode[] {
  const nodes = todos.map((todo, index) => makeNode(todo, index));
  const byId = new Map(nodes.map((node) => [node.key, node]));
  const roots: TodoTreeNode[] = [];

  for (const node of nodes) {
    const parentId = typeof node.todo.parentId === 'string' ? node.todo.parentId.trim() : '';
    const parent = parentId ? byId.get(parentId) : null;
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }
    node.depth = parent.depth + 1;
    parent.children.push(node);
  }

  return roots;
}

function buildInferredTree(todos: TodoItem[]): TodoTreeNode[] {
  const roots: TodoTreeNode[] = [];
  const stack: TodoTreeNode[] = [];

  todos.forEach((todo, index) => {
    const depth = inferredDepth(todo);
    const node = makeNode(todo, index, depth);
    const parent = depth > 0 ? stack[depth - 1] : null;

    if (parent) parent.children.push(node);
    else roots.push(node);

    stack[depth] = node;
    stack.length = depth + 1;
  });

  return roots;
}

export function buildTodoTree(todos: TodoItem[]): TodoTreeNode[] {
  if (!Array.isArray(todos) || todos.length === 0) return [];
  return hasExplicitParents(todos) ? buildExplicitTree(todos) : buildInferredTree(todos);
}

export function todoTreeDisplayText(node: TodoTreeNode): string {
  if (node.todo.status === 'in_progress' && node.activeLabel) return node.activeLabel;
  return node.label || node.activeLabel;
}
