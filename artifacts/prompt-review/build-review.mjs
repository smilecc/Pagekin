import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

const root = process.cwd();
const out = path.join(root, 'artifacts/prompt-review');
const entry = `export { BUILTIN_PROMPTS, composePromptSystemRole } from './src/services/builtin-prompt-templates';
export { characterArchitecturePrompts } from './src/services/prompt-language';
export { blueprintSemanticGenerationContract } from './src/shared/blueprint-semantic-contract';
export { draftShortOutlinePrompt } from './src/shared/draft-short-outline';
export { chapterTimeContinuity, reviewTimeContinuity } from './src/shared/chapter-time-continuity';
export { getBuiltinWritingSkills, readBuiltinWritingSkill } from './src/shared/builtin-writing-skills';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const esc = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const source = file => fs.readFileSync(path.join(root,file),'utf8');
const link = (file, line=1) => `<code>${esc(file)}:${line}</code>`;
const pre = value => `<pre>${esc(value)}</pre>`;
const block = (title, value, open=false) => `<details ${open?'open':''}><summary>${esc(title)}</summary>${pre(value)}</details>`;
const stages = [
  ['大纲', ['generate_novel_config_field'], 'GenerateFieldCommand(coreOutline)。与文风、全局写作要求共用模板，靠 field_label / field_requirements 区分。已有文字会保留，并追加生成结果。', 'src/services/workflows/commands/generate-field.command.ts'],
  ['世界观', ['world_building'], 'GenerateWorldBuildingCommand。core_outline 变量取 config.coreOutline（大纲）。直接注入类型、project-core.worldbuilding、全局要求和当次指导；该命令没有直接注入角色名单或参考作品。支持有界续写。', 'src/services/workflows/commands/architecture.command.ts'],
  ['角色名单', ['character_dynamics'], '实际为两步：先冻结 3–8 人身份和关系清单，再分批生成详情。两个步骤都会使用 character_dynamics 的 systemRole、content 和 taskGuidance，再追加身份清单或详情输出合同。世界观统一读取当前世界观页面；完整作者材料只注入一次，模板变量引用该材料。', 'src/services/workflows/commands/architecture.command.ts'],
  ['文风', ['generate_novel_config_field','analyze_writing_style'], '页面 AI 生成走 writingStyle 单字段生成；从文本/章节分析文风则用 analyze_writing_style，属于不同操作。', 'src/services/workflows/commands/analyze-style.command.ts'],
  ['全局写作要求', ['generate_novel_config_field'], 'GenerateFieldCommand(globalGuidance)。4–8 条、总计不超过 600 字符，禁止逐章大纲。格式不合格时只允许一次完整替代重试；已有作者文字保留。', 'src/services/workflows/commands/generate-field.command.ts'],
  ['写作选项', ['generate_global_config'], '只有“AI 补全其余设定”调用模型。类型、细分类型、篇幅、读者、视角、结构、提醒阈值的手动编辑本身没有提示词。参考作品没有独立 AI 生成提示，作为其他步骤的上下文。注意：补全并非只生成本页选项，会补全大纲、全局要求和文风，不再生成第二份世界设定。', 'src/services/workflows/commands/architecture.command.ts'],
  ['故事规划', ['chapter_blueprint_chunk'], 'GenerateDirectoryCommand：读取大纲 + 角色架构 + 世界观，带最近章节规划、范围、类型、全局要求、节奏指导。追加语义合同、章节容量合同和每章目标字数说明。单章压缩重试另有提示；详见补充代码。模型生成 title（章节名）、keyEvents（规划正文）和 characters（出场角色姓名数组），chapterNumber 用于定位。出场角色使用角色名单中的准确姓名，正文写作时据此注入资料；不生成关系、角色候选、功能、目的、悬念等旧字段，也不触发角色候选同步。', 'src/services/workflows/commands/directory.command.ts'],
  ['正文生成', ['first_chapter_draft','next_chapter_draft'], '首章和后续章节使用不同模板。新运行先生成最多六条的短细纲，再生成正文；注入有来源的作者材料、角色资料、前序定稿、未来规划、知识库与活跃线索、文风、当章指导、执行合同与字数合同。旧摘要等占位不一定填入，空段落会裁剪。', 'src/services/workflows/commands/generate-draft.command.ts'],
  ['审稿', ['consistency_check'], '注入当前正文、角色状态、已准入的定稿历史、世界观和作者关注点；还有章目标与时间连续性约束。', 'src/services/workflows/commands/review-chapter.command.ts'],
  ['修稿', ['refine_chapter','refine_from_review'], '普通修稿与根据审稿修稿两条路径；后者使用已准入的审稿报告与作者指令，不是把全部旧报告无条件拼入。', 'src/services/workflows/commands/refine-from-review.command.ts'],
  ['定稿后更新', ['generate_chapter_notes','update_character_cards'], '生成章节笔记/连续性资料与角色更新候选。角色更新有结构化校验和提交约束；不是再次自由创作正文。主进程固定来源。', 'electron/services/finalization-generation-source.ts'],
  ['导入小说', ['infer_novel_config_with_vectors','infer_novel_config','infer_single_chapter_blueprint'], '根据原文与检索片段反推配置、世界观、角色候选及每章规划；另外叠加不可变 JSON 合同。分析文风复用 analyze_writing_style。', 'src/services/workflows/commands/import-novel.command.ts'],
  ['编辑器与辅助操作', ['edit_selected_text','planning_material_character_extraction','assistant_writing_identity'], '分别对应选中文本改写、从材料提取角色、Agent 写作身份。Agent 还动态组合工具说明与对话上下文；剧情树/伏笔使用独立代码提示，不是左侧文档模板。', 'electron/services/editor-inline-generation.ts'],
];
const notes = [
  '本报告是当前工作区代码快照（含未提交修改）的审阅稿，不是某次模型请求日志。没有虚构项目正文，也未读取用户全局或项目级自定义模板。{{变量}} 或 ${表达式} 保留为运行时占位。',
  '模板解析优先级：当前项目覆盖 > 全局覆盖 > 内置。实际请求还会受本次选用的写作 Skill、用户指导、模型策略、材料选择和续写/结构化修复分支影响。下列内置全文是默认来源，不保证等于你已配置覆盖后的最终请求。',
  '常规组成：systemRole + 不可变中文/事实/协议合同；user = 模板正文变量替换 + taskGuidance + 内置 systemSuffix + 必需上下文补齐 + 命令附加合同。角色生成等特殊路径另列。',
  '本稿已同步本轮清理后的实际提示词。部分内部标识仍使用 blueprint/keyEvents；页面统一称故事规划/规划正文。',
];
const issues = [
  '已删除故事前提和情节大纲生成命令、synopsis 模板与未使用的全量蓝图模板；主进程拒绝已移除的生成操作。',
  '主角人设、金手指、独立 worldSetting 已从配置类型、默认项目、读写映射与导入合同移除。正文不再读取 premise 或 synopsis。',
  '世界观以 project-core.worldbuilding 为唯一数据源；角色生成、正文、修稿使用该来源；正文优先按出场角色名单注入资料，并从规划正文补充识别姓名和别名，避免只使用代词或称谓时漏掉角色。大纲以 config.coreOutline 为准，导出与剧情树使用该内容。',
  '故事规划模型合同为 chapterNumber、title、keyEvents、characters；characters 必须是准确姓名数组，无角色时返回空数组。所有生成、导入、单章压缩重试、Agent 修改均使用当前页面字段。底层通用数据库适配器将不使用的旧列清空，不保留旧内容或执行迁移。',
  '角色模板正文现已实际进入身份清单与详情两步调用；不能用模板指导覆盖两步的 JSON 输出合同。',
];
let html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>当前提示词审阅 · 2026-11-04</title><style>body{margin:0;background:#f7f6f2;color:#252a2c;font:16px/1.75 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:40px 28px}h1,h2,h3{line-height:1.35}h2{margin-top:48px;border-bottom:1px solid #d5d7d2;padding-bottom:12px}a{color:#14685d}table{border-collapse:collapse;width:100%;background:white}td,th{padding:12px;border:1px solid #d5d7d2;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:20px;border:1px solid #e1e1da;font:14px/1.8 ui-monospace,monospace}code{font-size:13px;overflow-wrap:anywhere}details{margin:14px 0}summary{cursor:pointer;font-weight:600}.note{background:#eaf1ec;padding:18px 24px}.issue{background:#fff0d8;padding:18px 24px}nav{display:flex;flex-wrap:wrap;gap:8px 20px;position:sticky;top:0;background:#f7f6f2;padding:12px 0}button{padding:6px 12px;cursor:pointer}@media print{nav,button{display:none}details{break-inside:avoid}main{padding:0}pre{font-size:11px}}</style><main><h1>当前提示词审阅</h1><p>2026-11-04 · 按当前创作流程整理 · 代码中的原文快照</p><nav><a href="#map">流程索引</a><a href="#issues">清理结果</a><a href="#actual">动态提示</a><a href="#templates">模板全文</a><a href="#skills">写作 Skill</a><a href="#sources">补充代码</a></nav><div class="note">${notes.map(n=>`<p>${esc(n)}</p>`).join('')}</div><p><button onclick="document.querySelectorAll('details').forEach(d=>d.open=true)">展开全文</button> <button onclick="document.querySelectorAll('details').forEach(d=>d.open=false)">折叠全文</button></p><h2 id="map">1. 各环节实际调用</h2><table><tr><th>环节</th><th>提示词与调用方式</th></tr>${stages.map(([name,keys,note,file])=>`<tr><td>${esc(name)}</td><td>${keys.map(key=>`<a href="#t-${key}"><code>${key}</code></a>`).join(' / ')}<p>${esc(note)}</p>${link(file)}</td></tr>`).join('')}</table><h2 id="issues">2. 本轮清理结果</h2><div class="issue"><ol>${issues.map(s=>`<li>${esc(s)}</li>`).join('')}</ol></div><h2 id="actual">3. 模板之外实际追加的提示</h2>`;
const supplemental = [];
const add = (title,text,file) => { supplemental.push({title,text,file}); html += `<h3>${esc(title)}</h3>${link(file)}${pre(text)}`; };
add('通用 system 合同',api.composePromptSystemRole({},'zh-CN'),'src/services/builtin-prompt-templates.ts');
const fieldFile='src/services/workflows/commands/generate-field.command.ts';
const parsed=ts.createSourceFile(fieldFile,source(fieldFile),ts.ScriptTarget.Latest,true);
function visit(node){
  if(ts.isVariableDeclaration(node)&&node.name.getText(parsed)==='fieldPrompts'&&ts.isObjectLiteralExpression(node.initializer)){
    for(const prop of node.initializer.properties){
      if(!ts.isPropertyAssignment(prop)||!ts.isArrayLiteralExpression(prop.initializer))continue;
      const key=prop.name.getText(parsed); if(!['coreOutline','writingStyle','globalGuidance'].includes(key))continue;
      const value=prop.initializer.elements[0];
      add(`单字段专用要求：${key}`,ts.isStringLiteralLike(value)?value.text:value.getText(parsed).slice(1,-1),fieldFile);
    }
  }ts.forEachChild(node,visit);
}visit(parsed);
const cp=api.characterArchitecturePrompts('zh-CN');
add('角色身份清单 system（另加模板 systemRole 与通用合同）',cp.manifestSystem,'src/services/prompt-language.ts');
add('角色身份清单 user',cp.manifestTask('{{大纲、类型、worldbuilding、全局要求、当次指导、参考作品的 JSON}}',3,8),'src/services/prompt-language.ts');
add('角色详情 system（另加模板 systemRole 与通用合同）',cp.detailSystem,'src/services/prompt-language.ts');
add('角色详情 user',cp.detailTask({context:'{{角色生成上下文 JSON}}',manifest:'{{已冻结身份清单}}',slotIds:'{{本批 slotId}}',validatedPrefix:'{{已验证的前批详情}}'}),'src/services/prompt-language.ts');
add('故事规划语义合同',api.blueprintSemanticGenerationContract('zh-CN'),'src/shared/blueprint-semantic-contract.ts');
add('正文生成前的短细纲 user',api.draftShortOutlinePrompt('zh-CN','{{已组装的本章正文生成原始提示，包括材料与约束}}'),'src/shared/draft-short-outline.ts');
add('正文时间连续性',api.chapterTimeContinuity('zh-CN'),'src/shared/chapter-time-continuity.ts');
add('审稿时间连续性',api.reviewTimeContinuity('zh-CN'),'src/shared/chapter-time-continuity.ts');
html += '<h2 id="templates">4. 内置模板全文</h2><p>逐项原样导出。systemSuffix 虽然名称含 system，常规渲染中是追加到 user 正文末尾。角色的两步生成方式见流程索引。</p>';
for(const t of api.BUILTIN_PROMPTS){
 html += `<article id="t-${esc(t.key)}"><h3>${esc(t.name)} · <code>${esc(t.key)}</code></h3><p>${esc(t.description)}</p>${block('System 角色',t.systemRole||'（未定义）')}${block('User 模板正文',t.content)}${t.taskGuidance?block('Task guidance',t.taskGuidance):''}${t.systemSuffix?block('不可编辑的输出约束 systemSuffix',t.systemSuffix):''}${block('变量说明与必须保留的上下文',JSON.stringify({variables:t.variables,requiredContextVariables:t.requiredContextVariables||[]},null,2))}</article>`;
}
html += '<h2 id="skills">5. 写作 Skill（仅选中绑定后注入，不是全部自动启用）</h2>';
const skills=api.getBuiltinWritingSkills().map(s=>({name:s.metadata.name,displayName:s.metadata.displayName,content:api.readBuiltinWritingSkill(s.metadata.name,'zh-CN')}));
for(const s of skills)html+=block(s.displayName||s.name,s.content);
html += '<h2 id="sources">6. 动态拼接、输出合同与辅助分支原始代码</h2><p>以下补充保留代码形式，便于核对条件分支、长度范围、压缩重试、资料选择与修复。它们并非全部会在一次请求中执行；字符串中的变量需要运行时填充。</p>';
const selections = [
 ['src/services/workflows/commands/architecture.command.ts',['buildNovelConfigJSONContract']],
 ['src/services/workflows/commands/directory.command.ts',['blueprintCapacityGenerationContract','buildCompactBlueprintTask']],
 ['src/services/workflows/commands/generate-draft.command.ts',['chapterLengthContractText','chapterExecutionContractText']],
 ['src/shared/plot-outline-contract.ts',['planningTargetInstruction']],
];
const snippets=[];
for(const [file,names] of selections){
 const sf=ts.createSourceFile(file,source(file),ts.ScriptTarget.Latest,true);
 for(const node of sf.statements)if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)){
  const line=sf.getLineAndCharacterOfPosition(node.getStart(sf)).line+1;
  const text=node.getText(sf);snippets.push({file,line,text});html+=`<p>${link(file,line)}</p>${block(node.name.text,text)}`;
 }
}
const files=[
 'src/services/workflows/commands/import-inference-contract.ts',
 'src/services/workflows/commands/planning-material.command.ts',
 'src/services/workflows/structured-syntax-repair.ts',
 'src/services/workflows/bounded-completion.ts',
 'src/shared/structured-replacement-prompt.ts',
 'src/shared/plot-tree-generation-pure.ts',
 'src/shared/narrative-thread-generation-pure.ts',
 'src/services/agent/context-builder.ts',
 'electron/services/agent-generation-context.ts',
 'electron/services/finalization-generation-source.ts',
 'src/services/workflows/commands/review-chapter.command.ts',
 'src/services/workflows/commands/refine-draft.command.ts',
 'src/services/workflows/commands/refine-from-review.command.ts',
 'src/shared/render-prompt.ts',
];
for(const file of files){const text=source(file);snippets.push({file,line:1,text});html+=`<p>${link(file)}</p>${block(file,text)}`;}
html+='</main></html>';
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'提示词审阅.html'),html);
fs.writeFileSync(path.join(out,'提示词快照.json'),JSON.stringify({date:'2026-11-04',scope:notes,stages,issues,templates:api.BUILTIN_PROMPTS,supplemental,skills,snippets},null,2));
console.log(JSON.stringify({templates:api.BUILTIN_PROMPTS.length,supplemental:supplemental.length,skills:skills.length,sourceExcerpts:snippets.length,htmlBytes:Buffer.byteLength(html)}));

