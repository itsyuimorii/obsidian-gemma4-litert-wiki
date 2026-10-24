import type { TextKey } from './en.ts';
import { en } from './en.ts';
import { ja } from './ja.ts';
import { zh } from './zh.ts';

/** One interface language: its code as Obsidian reports it, its own name for itself, its text. */
export interface Language {
  code: string;
  name: string;
  texts: Partial<Record<TextKey, string>>;
}

/**
 * Every language the interface speaks. Adding one is a file beside these and
 * an entry here; nothing else in the source changes (#166).
 */
export const LANGUAGES: readonly Language[] = [en, ja, zh];
