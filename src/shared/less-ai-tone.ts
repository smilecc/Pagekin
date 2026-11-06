export const LESS_AI_TONE_REVISION = '42ee3b60b281a7fdab4ca4f920ff4dcef828a3ab'
export const TONE_SEMANTIC_BATCH = 12
export const TONE_REVIEW_BATCH = 24
export const SEMANTIC_LABELS = {
  rename: ['0组', '1组', '2组', '3组及以上', '无法判断'],
  cohesion: ['表面有连接词实际关系不清', '明确承接', '有关但转换突然', '主题跳转缺少说明', '无法判断'],
  colon: ['引语或人物发言', '标题时间比例元数据或版式用途', '定义或解释', '空转提示', '结论提示', '其他正文冒号', '无法判断'],
  iso3: ['高度同构', '部分同构', '只有词语重复句法不同', '只有语义并列句法不同', '无同构关系', '无法判断'],
} as const
export type SemanticKind = keyof typeof SEMANTIC_LABELS
export type ToneCandidate = Record<string, unknown> & { label?: string; confidence?: string; reason?: string }
export type ToneCandidates = { meta: Record<string, unknown> } & Record<SemanticKind, ToneCandidate[]>
export interface ToneDetection {
  metrics: Record<string, unknown>
  candidates: ToneCandidates
}
export interface ToneRules { revision: string; skill: string; criteria: string; detect: string }
export interface ToneFinding { id: string; rule: string; candidate: ToneCandidate; decision?: string; reason?: string; suggestion?: string }

/** Main recomputes a finite request budget from the frozen detection, not a renderer-supplied budget. */
export function toneRequestBound(source: string, detection: ToneDetection): number {
  const groups = Object.keys(SEMANTIC_LABELS).map(kind => detection.candidates[kind as SemanticKind])
  const rawHits = Object.values(detection.metrics.hits as Record<string, ToneCandidate[]>)
  if ([...groups, ...rawHits, detection.metrics.syn_hits].some(rows => !Array.isArray(rows))) throw new Error('TONE_DETECTION_INVALID')
  const semantic = groups.reduce((sum, rows) => sum + Math.ceil(rows.length / TONE_SEMANTIC_BATCH), 0)
  const findings = [...groups, ...rawHits, detection.metrics.syn_hits as ToneCandidate[]].reduce((sum, rows) => sum + rows.length, 0)
    + [...source.matchAll(/——|；|“/gu)].length
  // One format regeneration per structured batch/rewrite, plus report, verification and explicit retries.
  return 2 * (semantic + Math.ceil(findings / TONE_REVIEW_BATCH) + 1) + 2 + 6
}

export function toneFindings(source: string, detection: ToneDetection, semantic: ToneCandidates): ToneFinding[] {
  const result: ToneFinding[] = []
  const add = (rule: string, candidates: ToneCandidate[]) => candidates.forEach(candidate => result.push({ id: `finding-${result.length}`, rule, candidate }))
  for (const [rule, hits] of Object.entries(detection.metrics.hits as Record<string, ToneCandidate[]>)) add(rule, hits)
  add('同义词轮换启发式', detection.metrics.syn_hits as ToneCandidate[])
  for (const [name, pattern] of [['破折号', /——/gu], ['分号', /；/gu], ['引号', /“/gu]] as const) {
    add(name, [...source.matchAll(pattern)].map(match => ({ line: source.slice(0, match.index).split('\n').length, offset: match.index, excerpt: source.slice(Math.max(0, match.index - 50), match.index + 70) })))
  }
  for (const kind of Object.keys(SEMANTIC_LABELS) as SemanticKind[]) add(kind, semantic[kind])
  return result
}

export function reviewToneFindings(findings: ToneFinding[], output: string): ToneFinding[] {
  const rows = toneJsonItems(output)
  if (!Array.isArray(rows) || rows.length !== findings.length || new Set(rows.map(row => row?.id)).size !== findings.length) throw new Error('TONE_REVIEW_INVALID')
  return findings.map(finding => {
    const row = rows.find(item => item?.id === finding.id)
    if (!row || !['拟改', '保留', '误报', '待核/人审'].includes(row.decision) || typeof row.reason !== 'string' || !row.reason.trim() || typeof row.suggestion !== 'string') throw new Error('TONE_REVIEW_INVALID')
    return { ...finding, decision: row.decision, reason: row.reason, suggestion: row.suggestion }
  })
}
export interface LessAiToneChannels {
  'generation:tone-detect': { args: [string]; return: ToneDetection & { rules: ToneRules } }
  'generation:tone-report': { args: [{ before: string; after: string; semantic: ToneCandidates }]; return: { report: string; after: ToneDetection } }
}

export function parseToneJson(text: string): unknown {
  const source = text.trim()
  try { return JSON.parse(source) } catch { /* Models may wrap one result in Markdown or explanation. */ }
  const values: unknown[] = []
  let start = -1, inString = false, escaped = false
  const closers: string[] = []
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (start < 0) {
      if (char !== '{' && char !== '[') continue
      start = index
    }
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{' || char === '[') closers.push(char === '{' ? '}' : ']')
    else if (char === '}' || char === ']') {
      if (closers.pop() !== char) throw new Error('TONE_JSON_INVALID')
      if (closers.length === 0) {
        try { values.push(JSON.parse(source.slice(start, index + 1))) }
        catch { throw new Error('TONE_JSON_INVALID') }
        start = -1
      }
    }
  }
  // Never accept inner objects from a truncated array, or silently select one of two results.
  if (start >= 0 || values.length !== 1) throw new Error('TONE_JSON_INVALID')
  return values[0]
}

/** Object envelopes match providers' json_object mode; old array checkpoints remain readable. */
function toneJsonItems(text: string): unknown {
  const value = parseToneJson(text)
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'items' in value) return value.items
  return value
}

/** Keep the original candidates intact; models only supply closed labels by index. */
export function labelToneCandidates(kind: SemanticKind, candidates: ToneCandidate[], output: string): ToneCandidate[] {
  const rows = toneJsonItems(output)
  if (!Array.isArray(rows) || rows.length !== candidates.length) throw new Error('TONE_LABELS_INVALID')
  const seen = new Set<number>()
  for (const row of rows) {
    if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= candidates.length || seen.has(row.index)
      || !(SEMANTIC_LABELS[kind] as readonly string[]).includes(row.label)
      || !['高', '中', '低'].includes(row.confidence) || typeof row.reason !== 'string' || !row.reason.trim()) throw new Error('TONE_LABELS_INVALID')
    seen.add(row.index)
  }
  return candidates.map((candidate, index) => {
    const row = rows.find(item => item.index === index)!
    return { ...candidate, label: row.label, confidence: row.confidence, reason: row.reason }
  })
}
