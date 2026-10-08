import { useStore } from '../../stores';
import { AttachmentChip } from '../shared/AttachmentChip';

export function QuotedSelectionCard() {
  const quotedSelections = useStore(s => s.quotedSelections);
  const removeQuotedSelection = useStore(s => s.removeQuotedSelection);

  if (quotedSelections.length === 0) return null;

  return (
    <>
      {quotedSelections.map((selection, index) => (
        <AttachmentChip
          key={`${selection.sourceKind}:${selection.sourceFilePath || selection.sourceSessionPath || ''}:${selection.sourceMessageId || ''}:${selection.updatedAt || index}`}
          icon={<QuoteIcon />}
          name={selection.text}
          onRemove={() => removeQuotedSelection(index)}
        />
      ))}
    </>
  );
}

function QuoteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 11H5.5A2.5 2.5 0 0 1 8 8.5V7a4 4 0 0 0-4 4v5h4v-5Z" />
      <path d="M18 11h-2.5A2.5 2.5 0 0 1 18 8.5V7a4 4 0 0 0-4 4v5h4v-5Z" />
    </svg>
  );
}
