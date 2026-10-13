// 测试卡「沈砚」的导入链路：parseCardFile(JSON) → 应用字段 + 随卡世界书
// 判据：字段无一为空、文风示例按 <START> 合并、世界书条目带 constant/priority。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseCardFile } from '../src/lib/cardImport.js'
import { normalizeLore } from '../src/lib/lore.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawText = readFileSync(path.join(root, 'test-cards/shenyan.chara.json'), 'utf8')

const asFile = (name, type, text) => ({ name, type, text: async () => text })

describe('I1 · 导入测试卡（酒馆 V2 JSON）', () => {
  it('七个核心字段全部非空', async () => {
    const { card } = await parseCardFile(asFile('shenyan.chara.json', 'application/json', rawText))
    expect(card.name).toBe('沈砚')
    for (const k of ['description', 'personality', 'scenario', 'firstMessage', 'styleExamples', 'userPersona']) {
      expect(card[k].trim().length).toBeGreaterThan(20)
    }
  })

  it('mes_example 按 <START> 合并为文风示例，且宏 {{char}} 保留（编译时才展开）', async () => {
    const { card } = await parseCardFile(asFile('shenyan.chara.json', 'application/json', rawText))
    expect(card.styleExamples).toContain('———')
    expect(card.styleExamples).toContain('{{char}}')
    expect(card.styleExamples.split('———').length).toBe(3)
  })

  it('备选开场白 2 条，全部非空', async () => {
    const { card } = await parseCardFile(asFile('shenyan.chara.json', 'application/json', rawText))
    expect(card.alternateGreetings.length).toBe(2)
    expect(card.alternateGreetings.every((g) => g.trim())).toBe(true)
  })

  it('随卡世界书 3 条：关键词合并、常驻标记、优先级保留', async () => {
    const { loreEntries } = await parseCardFile(asFile('shenyan.chara.json', 'application/json', rawText))
    expect(loreEntries.length).toBe(3)
    const book = loreEntries.find((e) => e.content.includes('临江路 47 号'))
    expect(book.constant).toBe(true)
    expect(book.keys).toContain('拾遗书店')
    expect(book.priority).toBe(10)
    expect(loreEntries.every((e) => e.enabled === true)).toBe(true)
  })

  it('导入后条目经 normalizeLore 补齐 uid（删 1 条不会清空全部）', async () => {
    const { loreEntries } = await parseCardFile(asFile('shenyan.chara.json', 'application/json', rawText))
    const norm = normalizeLore(loreEntries)
    expect(norm.length).toBe(3)
    expect(new Set(norm.map((e) => e.uid)).size).toBe(3)
  })

  it('异常：缺 name 的文件被拒绝', async () => {
    await expect(parseCardFile(asFile('bad.json', 'application/json', '{"spec":"chara_card_v2","data":{}}')))
      .rejects.toThrow('name')
  })
})
