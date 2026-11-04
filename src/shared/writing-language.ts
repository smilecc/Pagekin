export const WRITING_LANGUAGES = ['zh-CN'] as const

// Transport values may contain a language supplied by an external caller.
export type WritingLanguage = 'zh-CN' | 'en-US'
export const DEFAULT_WRITING_LANGUAGE: WritingLanguage = 'zh-CN'

export function resolveWritingLanguage(_value?: unknown): WritingLanguage {
  void _value;
  return DEFAULT_WRITING_LANGUAGE
}

/** All built-in model-facing instructions use Chinese. */
export function writingLanguageText(_language: WritingLanguage, zhCNText: string, _unused?: string): string {
  void _language; void _unused;
  return zhCNText
}
