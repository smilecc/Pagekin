import { StructuredContractDiagnostic } from './structured-contract-diagnostic'
import { type CharacterRole } from './character-role'
import type { WritingLanguage } from './writing-language'

export interface BlueprintRelationshipFact {
  from: string
  to: string
  relation: string
}

/** A recurring named character first introduced by this blueprint. */
export interface BlueprintNewCharacterCandidate {
  name: string
  role: CharacterRole
}

/** Stable provenance input; validation code and qualification hash this same manifest. */
export const BLUEPRINT_SEMANTIC_CONTRACT_MANIFEST = Object.freeze({
  schemaVersion: 3,
  requiredFields: Object.freeze(['chapterNumber', 'title', 'keyEvents', 'characters'] as const),
  exactChapterCoverage: true,
} as const)

export function blueprintSemanticGenerationContract(_writingLanguage: WritingLanguage): string {
  void _writingLanguage
  return `【故事规划 JSON 合同】
只输出 {"blueprints":[...]}。每项仅包含 chapterNumber、title、keyEvents、characters。
chapterNumber 是章节定位编号，必须覆盖本批目标章节，不得重复、遗漏或越界。
title 是非空章节名；keyEvents 是非空的完整规划正文，可用自然段组织。
characters 是本章出场角色姓名的字符串数组，使用角色名单中的准确姓名，不能用代词或称谓代替；没有出场角色时返回 []。它用于注入角色资料，不能省略。
在规划正文中描述本章事件、人物行动、因果变化及需要保留的约束，不写小说正文。
不得输出关系、角色候选、章节功能、章节目的、悬念字段、备注或其他字段。
只输出 JSON，不要解释或代码围栏。`
}

export interface BlueprintSemanticItem {
  chapterNumber: number
  title: string
  keyEvents: string
  characters: string[]
}
export type BlueprintAuthorItem = BlueprintSemanticItem

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fieldValue(
  value: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[] = [],
): unknown {
  if (Object.hasOwn(value, canonical)) return value[canonical]
  for (const alias of aliases) {
    if (Object.hasOwn(value, alias)) return value[alias]
  }
  return undefined
}

function requiredText(value: unknown, path: string): string {
  if (value === undefined) throw new StructuredContractDiagnostic('missing_field', path)
  if (typeof value !== 'string') throw new StructuredContractDiagnostic('invalid_type', path)
  if (!value.trim()) throw new StructuredContractDiagnostic('empty_value', path)
  return value.trim()
}

function normalizedChapterNumber(value: Record<string, unknown>, path: string): number {
  const candidate = fieldValue(value, 'chapterNumber', ['chapter_number'])
  if (candidate === undefined) throw new StructuredContractDiagnostic('missing_field', `${path}.chapterNumber`)
  if (typeof candidate !== 'number' && typeof candidate !== 'string') {
    throw new StructuredContractDiagnostic('invalid_type', `${path}.chapterNumber`)
  }
  const chapterNumber = Number(candidate)
  if (!Number.isSafeInteger(chapterNumber) || chapterNumber < 1) {
    throw new StructuredContractDiagnostic('invalid_value', `${path}.chapterNumber`)
  }
  return chapterNumber
}

export function validateBlueprintSemanticItem(value: unknown): string | undefined {
  try {
    normalizeBlueprintSemanticItem(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function normalizeBlueprintSemanticItem(value: unknown, path = 'blueprint'): BlueprintSemanticItem {
  if (!isRecord(value)) throw new StructuredContractDiagnostic('invalid_type', path)
  if (!Array.isArray(value.characters)) throw new StructuredContractDiagnostic('invalid_type', `${path}.characters`)
  const characters = [...new Set(value.characters.map((name, index) => requiredText(name, `${path}.characters[${index}]`)))]
  return {
    chapterNumber: normalizedChapterNumber(value, path),
    title: requiredText(value.title, `${path}.title`),
    keyEvents: requiredText(value.keyEvents, `${path}.keyEvents`),
    characters,
  }
}

export function decodeBlueprintSemanticPayload(
  payload: unknown,
  expectedChapterNumbers: readonly number[],
): BlueprintSemanticItem[] {
  const candidates = isRecord(payload) && Object.hasOwn(payload, 'blueprints')
    ? payload.blueprints
    : payload
  if (!Array.isArray(candidates)) throw new StructuredContractDiagnostic('invalid_envelope', 'blueprints')

  const expected = new Set(expectedChapterNumbers)
  if (
    expected.size !== expectedChapterNumbers.length
    || expectedChapterNumbers.some(chapter => !Number.isSafeInteger(chapter) || chapter < 1)
  ) {
    throw new StructuredContractDiagnostic('invalid_value', 'expectedChapterNumbers')
  }

  const decoded = candidates.map((candidate, index) => normalizeBlueprintSemanticItem(candidate, `blueprints[${index}]`))
  const seen = new Set<number>()
  for (const blueprint of decoded) {
    if (seen.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('duplicate_item', 'blueprints')
    }
    seen.add(blueprint.chapterNumber)
    if (!expected.has(blueprint.chapterNumber)) {
      throw new StructuredContractDiagnostic('unexpected_item', 'blueprints')
    }
  }
  const missing = expectedChapterNumbers.filter(chapter => !seen.has(chapter))
  if (missing.length > 0) {
    throw new StructuredContractDiagnostic('missing_item', 'blueprints')
  }
  return decoded.sort((left, right) => left.chapterNumber - right.chapterNumber)
}

/**
 * Accepts exactly one JSON root or one complete Markdown JSON fence. It never
 * searches narrative prose for a nested JSON fragment.
 */
function parseBlueprintJsonText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  const candidate = fenced ? fenced[1].trim() : trimmed
  if (!candidate || !/^[{[]/u.test(candidate)) {
    throw new StructuredContractDiagnostic('invalid_envelope', '$')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new StructuredContractDiagnostic('invalid_json', '$')
  }
  return parsed
}

export function parseBlueprintSemanticResponseText(text: string, expectedChapterNumbers: readonly number[]): BlueprintSemanticItem[] {
  return decodeBlueprintSemanticPayload(parseBlueprintJsonText(text), expectedChapterNumbers)
}

export function decodeBlueprintAuthorPayload(payload: unknown, expectedChapterNumbers: readonly number[]): BlueprintAuthorItem[] {
  return decodeBlueprintSemanticPayload(payload, expectedChapterNumbers)
}

export function parseBlueprintAuthorResponseText(text: string, expectedChapterNumbers: readonly number[]): BlueprintAuthorItem[] {
  return decodeBlueprintAuthorPayload(parseBlueprintJsonText(text), expectedChapterNumbers)
}
