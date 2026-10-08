export const COMPOSER_PRESENTATION = 'codia-input-presentation';
export const AGENT_REVIEW_RECORD = 'codia-agent-review';

/** Custom entries are UI metadata, never model instructions. Keep source indices stable. */
export function projectComposerHistory(messages: any[], isPending: (id: string) => boolean = () => false): any[] {
  const reviews = new Map<string, any>();
  for (const message of messages) {
    if (message.customType === AGENT_REVIEW_RECORD && message.data?.review?.requestId) {
      reviews.set(message.data.review.requestId, message.data.review);
    }
  }
  let presentation: any = null;
  return messages.map(message => {
    if (message.customType === AGENT_REVIEW_RECORD && message.data?.displayMessage) {
      const data = message.data;
      let review = reviews.get(data.review.requestId) || data.review;
      if (['running', 'continuing'].includes(review.status) && !isPending(review.requestId)) {
        review = { ...review, status: 'failed', error: '审阅因应用关闭或连接中断而停止，请重新发送。' };
      }
      return { ...message, role: 'user', content: data.displayMessage.text || '',
        presentation: { ...data.displayMessage, agentReview: review } };
    }
    if (message.customType === COMPOSER_PRESENTATION) {
      presentation = message.data;
      return message;
    }
    if (message.role !== 'user' || !presentation) return message;
    const data = presentation;
    presentation = null;
    if (data.reviewRequestId) return { ...message, role: 'custom', display: false };
    return { ...message, content: data.text ?? message.content, presentation: data };
  });
}
