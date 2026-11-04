import { describe, expect, it } from 'vitest'
import { BUILTIN_PROMPTS, composePromptSystemRole, getBuiltinPromptTemplate } from '../prompt-templates'
import { characterArchitecturePrompts } from '../prompt-language'
import { WRITING_LANGUAGES, resolveWritingLanguage } from '../../shared/writing-language'
import { getPlanningMaterialExtractionTemplate } from '../../shared/planning-material-prompts'
import { getBuiltinWritingSkills } from '../../shared/builtin-writing-skills'

describe('Chinese-only writing prompts', () => {
  it('exposes Chinese as the only writing language', () => {
    expect(WRITING_LANGUAGES).toEqual(['zh-CN'])
    expect(resolveWritingLanguage('en-US')).toBe('zh-CN')
  })
  it.each(BUILTIN_PROMPTS.map(item => item.key))('%s cannot select an English template', key => {
    expect(getBuiltinPromptTemplate(key, 'en-US')).toEqual(getBuiltinPromptTemplate(key, 'zh-CN'))
    expect(composePromptSystemRole(getBuiltinPromptTemplate(key, 'zh-CN')!, 'en-US')).toContain('使用中文')
  })
  it('uses Chinese for character and material extraction instructions', () => {
    expect(characterArchitecturePrompts('en-US').manifestSystem).toContain('角色身份规划器')
    expect(getPlanningMaterialExtractionTemplate('en-US').systemRole).toContain('小说角色')
  })
  it('ships no English writing skill bodies', () => {
    for (const skill of getBuiltinWritingSkills()) expect(skill.localizedContent?.['en-US']).toBeUndefined()
  })
})

describe('removed planning inputs', () => {
  it('does not publish a premise prompt or request removed profile fields', () => {
    expect(BUILTIN_PROMPTS.some(prompt => prompt.key === 'premise')).toBe(false)
    const prompts = JSON.stringify(BUILTIN_PROMPTS)
    expect(prompts).not.toContain('golden_finger')
    expect(prompts).not.toContain('protagonist_profile')
    expect(prompts).not.toContain('goldenFinger')
    expect(prompts).not.toContain('protagonistProfile')
  })
})
