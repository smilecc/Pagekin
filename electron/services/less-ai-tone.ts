import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LESS_AI_TONE_REVISION, type ToneCandidates, type ToneDetection } from '../../src/shared/less-ai-tone'

const validateText = (text: string) => {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 8 * 1024 * 1024) throw new Error('TONE_TEXT_INVALID')
}
function execute(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, {
    cwd, windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  }, (error, stdout) => error ? reject(error) : resolve(stdout)))
}
async function python(cwd: string) {
  for (const command of process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    try { if ((await execute(command, ['-c', 'import sys; print(sys.version_info.major)'], cwd)).trim() === '3') return command } catch { /* Try the next installed Python. */ }
  }
  throw new Error('TONE_PYTHON_REQUIRED')
}
async function workspace<T>(root: string, fn: (dir: string, command: string) => Promise<T>): Promise<T> {
  const command = await python(root)
  const dir = await mkdtemp(path.join(tmpdir(), 'pagekin-tone-'))
  try { return await fn(dir, command) } finally { await rm(dir, { recursive: true, force: true }) }
}
async function detect(root: string, dir: string, command: string, name: string, text: string): Promise<ToneDetection> {
  await writeFile(path.join(dir, name), text, 'utf8')
  const script = path.join(root, 'scripts', 'detect.py')
  let metrics: Record<string, unknown>
  try { metrics = JSON.parse(await execute(command, [script, name, '--json'], dir)) }
  catch (error) {
    // Keep the upstream minimum, including its own rounding/counting behavior.
    if (String(error).includes('汉字过少')) throw new Error('TONE_TOO_SHORT')
    throw error
  }
  const candidates = JSON.parse(await execute(command, [script, name, '--candidates'], dir))
  return { metrics, candidates }
}
/** Executes pinned upstream files, without shell interpolation or model-selected paths. */
export async function detectLessAiTone(root: string, text: string) {
  validateText(text)
  return workspace(root, async (dir, command) => ({
    ...await detect(root, dir, command, 'before.md', text),
    rules: { revision: LESS_AI_TONE_REVISION,
      skill: await readFile(path.join(root, 'SKILL.md'), 'utf8'),
      criteria: await readFile(path.join(root, 'references', 'semantic-criteria.md'), 'utf8'),
      detect: await readFile(path.join(root, 'DETECT.md'), 'utf8') },
  }))
}
export async function reportLessAiTone(root: string, input: { before: string; after: string; semantic: ToneCandidates }) {
  validateText(input?.before); validateText(input?.after)
  if (!input.semantic || Buffer.byteLength(JSON.stringify(input.semantic), 'utf8') > 16 * 1024 * 1024) throw new Error('TONE_LABELS_INVALID')
  return workspace(root, async (dir, command) => {
    const before = await detect(root, dir, command, 'before.md', input.before)
    const after = await detect(root, dir, command, 'after.md', input.after)
    await writeFile(path.join(dir, 'before.json'), JSON.stringify(before.metrics), 'utf8')
    await writeFile(path.join(dir, 'after.json'), JSON.stringify(after.metrics), 'utf8')
    await writeFile(path.join(dir, 'semantic.json'), JSON.stringify(input.semantic), 'utf8')
    await execute(command, [path.join(root, 'scripts', 'report.py'), 'before.md', 'after.md', 'before.json', 'after.json', '--semantic', 'semantic.json', '--out', 'report.md'], dir)
    return { report: await readFile(path.join(dir, 'report.md'), 'utf8'), after }
  })
}
