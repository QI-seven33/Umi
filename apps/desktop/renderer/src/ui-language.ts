import { useSyncExternalStore } from 'react';
import { english } from './ui-translations.js';
export type UiLanguage = 'zh-CN' | 'en';
let language: UiLanguage = 'zh-CN';
const listeners = new Set<() => void>();
export function setUiLanguage(value: UiLanguage) {
  language = value;
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  for (const notify of listeners) notify();
}
export const getUiLanguage = () => language;
export function useUiLanguage() {
  return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, () => language, () => language);
}
// Only UI-owned labels pass through this function. User/Agent text stays untouched.
export function t(source: string, values?: Record<string, string | number>): string {
  const text = language === 'en' ? english[source] ?? source : source;
  return values ? text.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match)) : text;
}
