import type { NovelConfig } from '../../../shared/ipc-channels'
import type { SetupField } from '../../../stores/navigation/stage-progress'
import type { GeneratableField } from '../../../services/workflows/commands/generate-field.command'

type Pair = readonly [string, string]

export const POV_OPTIONS: readonly (readonly [NovelConfig['narrativePOV'], Pair])[] = [
  ['third_limited', ['第三人称有限', 'Third-person limited']],
  ['first_person', ['第一人称', 'First person']],
  ['third_omniscient', ['第三人称全知', 'Third-person omniscient']],
  ['multi_pov', ['多视角轮换', 'Multiple POV']],
]

export const STRUCTURE_OPTIONS: readonly (readonly [NovelConfig['plotStructure'], Pair])[] = [
  ['three_act', ['三幕结构', 'Three-act']],
  ['heros_journey', ['英雄之旅', 'Hero’s journey']],
  ['save_the_cat', ['节拍表', 'Beat sheet']],
  ['kishotenketsu', ['起承转合', 'Kishōtenketsu']],
  ['multi_thread', ['多线叙事', 'Multi-thread']],
  ['freeform', ['自由结构', 'Freeform']],
]

/** 必填项的名字，与流程脊「还差 N 项」同一组。 */
export const REQUIRED_NAMES: Record<SetupField, Pair> = {
  coreOutline: ['大纲', 'outline'],
  genre: ['类型', 'genre'],
  length: ['篇幅', 'length'],
  targetAudience: ['目标读者', 'target readers'],
}

/** 只缺一项时，提示直接说怎么补齐。 */
export const ONE_MISSING_HINT: Record<SetupField, Pair> = {
  coreOutline: ['写下大纲就能继续', 'Write the outline to continue'],
  genre: ['选好类型就能继续', 'Choose a genre to continue'],
  length: ['填好篇幅就能继续', 'Set the length to continue'],
  targetAudience: ['选好目标读者就能继续', 'Choose target readers to continue'],
}

/** 「更多设定」里的一项：长文本、单行文本或下拉。aiField 是可单独让 AI 生成的字段。 */
export type MoreField =
  | { id: 'subGenre'; kind: 'line'; name: Pair; placeholder: Pair }
  | { id: 'narrativePOV'; kind: 'pov'; name: Pair }
  | { id: 'plotStructure'; kind: 'structure'; name: Pair }
  | { id: 'writingStyle' | 'globalGuidance' | 'referenceWorks'; kind: 'text'; name: Pair; desc: Pair; placeholder: Pair; aiField?: GeneratableField }

export const MORE_FIELDS: readonly MoreField[] = [
  { id: 'narrativePOV', kind: 'pov', name: ['叙事视角', 'Point of view'] },
  { id: 'plotStructure', kind: 'structure', name: ['故事结构', 'Story structure'] },
  { id: 'subGenre', kind: 'line', name: ['细分类型', 'Subgenre'], placeholder: ['如：修仙/重生/末世', 'e.g. cultivation / rebirth / post-apocalyptic'] },
  { id: 'writingStyle', kind: 'text', name: ['文风', 'Writing style'], aiField: 'writingStyle',
    desc: ['写稿、修稿时 AI 会严格遵循这里的风格要求。', 'AI follows this style when drafting and revising.'],
    placeholder: ['句子长短、用词、节奏、叙述距离……', 'Sentence length, diction, rhythm, narrative distance…'] },


  { id: 'globalGuidance', kind: 'text', name: ['全局写作要求', 'Global guidance'], aiField: 'globalGuidance',
    desc: ['贯穿全书的规则：禁忌、节奏、必须遵守的写法。', 'Book-wide rules: what to avoid, pacing, house style.'],
    placeholder: ['全局的写作风格要求、禁忌事项、特殊规则……', 'Style requirements, restrictions, special rules…'] },
  { id: 'referenceWorks', kind: 'text', name: ['参考作品', 'References'],
    desc: ['参考哪些作品的风格、设定或机制。', 'Works whose style, setting or mechanics to draw on.'],
    placeholder: ['如：参考《证道》的修炼体系', 'e.g. the magic system of a favourite series'] },
]
