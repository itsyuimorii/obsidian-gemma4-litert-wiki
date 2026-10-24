import { EN_TEXTS, en, type TextKey } from './texts/en.ts';
import { LANGUAGES, type Language } from './texts/index.ts';

// The interface language (#166). Pure, so the choice and the fallback are
// under test without Obsidian: main.ts reads Obsidian's language and the
// setting, and hands both to resolveLanguage.

type Vars = Record<string, string | number>;

/** The keys that come as a `.one` / `.other` pair, named without the suffix. */
export type CountKey = {
  [K in TextKey]: K extends `${infer Base}.one` ? Base : never;
}[TextKey];

let active: Language = en;

/**
 * Which language to show. A setting other than `auto` wins when it names a
 * language there is a file for. Otherwise Obsidian's own language, exact code
 * first and then its base (`zh-TW` reads `zh`), and English when neither is
 * one this plugin has.
 */
export function resolveLanguage(setting: string, appLanguage: string): Language {
  const find = (code: string) => LANGUAGES.find((l) => l.code === code);
  if (setting && setting !== 'auto') {
    const chosen = find(setting);
    if (chosen) return chosen;
  }
  const app = (appLanguage || 'en').toLowerCase();
  return find(app) ?? find(app.split('-')[0]) ?? en;
}

export function setLanguage(language: Language): void {
  active = language;
}

export function activeLanguage(): Language {
  return active;
}

/** The text for `key` in the active language, English if it has none, with `{name}` filled in. */
export function t(key: TextKey, vars?: Vars): string {
  const raw = active.texts[key] ?? EN_TEXTS[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** A count: the `.one` text when `n` is 1, the `.other` text otherwise, with `{n}` filled in. */
export function tn(key: CountKey, n: number, vars?: Vars): string {
  return t(`${key}.${n === 1 ? 'one' : 'other'}` as TextKey, { n, ...vars });
}
