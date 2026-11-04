import type { WritingLanguage } from './writing-language'

/** Single source for the built-in material extraction instructions. */
export function getPlanningMaterialExtractionTemplate(_language: WritingLanguage) {
  void _language;
  return {
    systemRole: '你从作者资料中提取明确出现的小说角色。不得虚构新角色或改写作者事实。只输出严格 JSON。',
    content: `为每个资料块返回且只返回一个结果，sourceId 必须完整覆盖 {{requested_ids}}。只写入资料明确陈述的事实；资料中明确陈述的每条角色事实都必须写入对应支持字段。每张角色卡必须有 name 和 role。资料未明确给出的可选字段必须省略，不得猜测、补齐或用空值占位。relationships 使用 {"target":"姓名","relation":"关系"} 数组；role 只能是 protagonist、antagonist、supporting、minor。\n输出合同（删除资料未明确给出的可选字段）：{"results":[{"sourceId":"精确资料块 ID","characterCards":[{"name":"姓名","role":"supporting","gender":"明确性别","age":"明确年龄","appearance":"明确外貌","personality":"明确性格","background":"明确经历、职业、背景或秘密","abilities":"明确能力","motivation":"明确动机","relationships":[{"target":"姓名","relation":"明确关系"}],"arc":"明确角色弧光","notes":"其他明确事实"}]}]}\n\n{{sources}}`,
  }
}
