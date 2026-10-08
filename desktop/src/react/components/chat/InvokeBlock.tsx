import { memo, useCallback, useState } from 'react';
import styles from './Chat.module.css';

interface Props {
  name: string;
  content: string;
}

export const InvokeBlock = memo(function InvokeBlock({ name, content }: Props) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen(v => !v), []);

  return (
    <div className={styles.invokeWrapper} data-invoke={name}>
      <button type="button" className={styles.invokeSummary} onClick={toggle}>
        <span className={`${styles.moodArrow}${open ? ` ${styles.moodArrowOpen}` : ''}`}>{'>'}</span>
        <span>{`<invoke name="${name}">`}</span>
      </button>
      {open && (
        <pre className={styles.invokeBlock}>{content}</pre>
      )}
    </div>
  );
});
