import { Fragment, memo, useEffect, useRef, type RefObject } from 'react';
import { UserCircle } from '@phosphor-icons/react';
import type { FileMentionItem } from '../../utils/file-mention-items';
import { kindOfFileName } from '../../utils/file-kind';
import { FileKindIcon } from '../shared/FileKindIcon';
import { FolderIcon } from '../shared/FolderIcon';
import styles from './InputArea.module.css';

export const FileMentionMenu = memo(function FileMentionMenu({
  items,
  selected,
  busy,
  onSelect,
  onHover,
}: {
  items: FileMentionItem[];
  selected: number;
  busy: boolean;
  onSelect: (item: FileMentionItem) => void;
  onHover: (index: number) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      className={styles['file-mention-menu']}
      role="listbox"
      aria-label="提及文件、图片或助手"
    >
      {items.map((item, i) => (
        <Fragment key={item.id}>
          {(i === 0 || items[i - 1]?.kind !== item.kind) && (
            <div className={styles['file-mention-group-label']}>
              {item.kind === 'assistant' ? '助手' : item.kind === 'image' ? '图片' : '文件'}
            </div>
          )}
          <FileMentionButton
            item={item}
            selected={i === selected}
            refProp={i === selected ? selectedRef : undefined}
            onHover={() => onHover(i)}
            onSelect={() => onSelect(item)}
          />
        </Fragment>
      ))}
      {items.length === 0 && <div className={styles['file-mention-empty']} role="status">
        {busy ? '正在搜索…' : '没有匹配的文件、图片或助手'}
      </div>}
    </div>
  );
});

function FileMentionButton({
  item,
  selected,
  refProp,
  onHover,
  onSelect,
}: {
  item: FileMentionItem;
  selected: boolean;
  refProp?: RefObject<HTMLButtonElement | null>;
  onHover: () => void;
  onSelect: () => void;
}) {
  const fileKind = kindOfFileName(item.name || item.path, item.mimeType);
  const thumbnailUrl = item.kind === 'image' && !item.isDirectory && item.path && typeof window !== 'undefined'
    ? window.platform?.getFileUrl?.(item.path)
    : null;

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      ref={refProp}
      className={`${styles['file-mention-item']}${selected ? ` ${styles.selected}` : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={onSelect}
    >
      <span className={styles['file-mention-icon']} aria-hidden="true">
        {item.kind === 'assistant' ? (
          <UserCircle size={20} weight="fill" />
        ) : thumbnailUrl ? (
          <img className={styles['file-mention-thumbnail']} src={thumbnailUrl} alt="" />
        ) : item.isDirectory ? <FolderIcon size={18} /> : <FileKindIcon kind={fileKind} size={18} />}
      </span>
      <span className={styles['file-mention-main']}>
        <span className={styles['file-mention-name']}>{item.name}</span>
        <span className={styles['file-mention-detail']}>{item.detail || item.path}</span>
      </span>
    </button>
  );
}
