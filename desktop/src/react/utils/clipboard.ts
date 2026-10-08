import { getDesktopApi } from './desktop-api';

export async function writeClipboardText(value: string): Promise<boolean> {
  try {
    const desktopApi = getDesktopApi();
    if (desktopApi?.writeClipboardText) {
      return await desktopApi.writeClipboardText(value);
    }
  } catch {
    // Fall back to renderer clipboard paths below.
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {

      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', 'readonly');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }
}
