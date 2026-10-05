export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds >= 60) {
    return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
  }
  return `${totalSeconds}s`;
}
