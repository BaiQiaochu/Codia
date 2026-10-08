import { useStore } from '../stores';

export function useI18n() {
  const locale = useStore(s => s.locale);
  return {
    t: window.t ?? ((path: string) => path),
    locale,
    i18n: window.i18n,
  };
}
