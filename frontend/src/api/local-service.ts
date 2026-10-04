import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, refreshRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  ConsultationGenerateResult,
  ConsultationOpinion,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// ===== 水位阈值会商 =====
// 处理顺序：先按阈值范围自动判定建议等级，再由值班员会商；人工意见与自动建议
// 冲突（驳回）时以人工意见为最终结论，自动建议原文留痕，会商记录标记为冲突。
// 会商全程不直接改写原水位记录；会商编号 = CONS-记录编号，同一水位记录只留一份会商，
// 重复生成/回放不产生新结论，已出结论的会商重复提交直接拒绝。
const CONSULTATION_KEY = 'consultation'
const WATERLEVEL_KEY = 'waterlevel'
const WARNING_KEY = 'warning'
const GRADE_NAMES = ['蓝色', '黄色', '橙色', '红色'] as const
const GRADE_FIELDS = GRADE_NAMES.map((name) => `${name}门槛`)
const CONFIG_GRADE_FIELDS = GRADE_NAMES.map((name) => `${name}阈值`)
// 站点原配置可能有多份，按生效程度取最可用的一份
const CONFIG_STATUS_ORDER = ['已生效', '已调整', '待调整', '草稿']

function toLevel(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function formatNow(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

// 门槛取值顺序：记录自带的各级门槛优先；存量缺门槛的沿用站点原配置（预警阈值模块）。
function resolveThresholds(row: EntryRow): { levels: number[]; source: string } | null {
  const own = GRADE_FIELDS.map((field) => toLevel(row[field]))
  if (own.every((level) => level !== null)) {
    return { levels: own as number[], source: '记录自带' }
  }
  const station = String(row['站点编号'] ?? '')
  const configs = listRows(WARNING_KEY)
    .filter(
      (config) =>
        String(config['站点编号'] ?? '') === station &&
        String(config['监测类型'] ?? '').includes('水位') &&
        String(config.status) !== '已停用',
    )
    .sort(
      (a, b) =>
        CONFIG_STATUS_ORDER.indexOf(String(a.status)) - CONFIG_STATUS_ORDER.indexOf(String(b.status)),
    )
  for (const config of configs) {
    const levels = CONFIG_GRADE_FIELDS.map((field) => toLevel(config[field]))
    if (levels.every((level) => level !== null)) {
      return { levels: levels as number[], source: '站点原配置' }
    }
  }
  return null
}

// 会商规则：当前水位落在哪一级门槛范围就建议哪一级预警，低于蓝色门槛则维持不变。
function suggestGrade(current: number, levels: number[]): string {
  for (let index = GRADE_NAMES.length - 1; index >= 0; index -= 1) {
    if (current >= levels[index]) {
      return `建议${GRADE_NAMES[index]}预警`
    }
  }
  return '建议维持不变'
}

export function generateConsultations(): ConsultationGenerateResult {
  refreshRows()
  const existing = listRows(CONSULTATION_KEY)
  const known = new Set(existing.map((row) => String(row['会商编号'] ?? '')))
  const next = [...existing]
  let created = 0
  let skipped = 0
  let missing = 0
  let id = nextId(next)
  const now = formatNow()
  for (const row of listRows(WATERLEVEL_KEY)) {
    const recordNo = String(row['记录编号'] ?? '').trim()
    if (!recordNo) {
      continue
    }
    const consultNo = `CONS-${recordNo}`
    if (known.has(consultNo)) {
      skipped += 1
      continue
    }
    const current = toLevel(row['当前水位'])
    const resolved = resolveThresholds(row)
    if (current === null || !resolved) {
      missing += 1
      continue
    }
    next.push({
      id: id,
      status: '待会商',
      pending: true,
      abnormal: false,
      会商编号: consultNo,
      记录编号: recordNo,
      站点编号: String(row['站点编号'] ?? ''),
      当前水位: current,
      蓝色门槛: resolved.levels[0],
      黄色门槛: resolved.levels[1],
      橙色门槛: resolved.levels[2],
      红色门槛: resolved.levels[3],
      门槛来源: resolved.source,
      自动建议: suggestGrade(current, resolved.levels),
      人工意见: '',
      处理理由: '',
      值班员: '',
      发起时间: now,
      会商时间: '',
      会商版本: 'V1',
    })
    known.add(consultNo)
    id += 1
    created += 1
  }
  if (created > 0) {
    saveRows(CONSULTATION_KEY, next)
  }
  const message = `本次生成 ${created} 份会商，跳过已有 ${skipped} 份，${missing} 条记录缺门槛未生成`
  return { created, skipped, missing, message }
}

// 采纳会商结论时在预警阈值模块补一条「待调整」记录；按会商编号去重，并发或重放只留一份。
function ensureWarningAdjustment(consultation: EntryRow): boolean {
  const rows = listRows(WARNING_KEY)
  const consultNo = String(consultation['会商编号'] ?? '')
  if (rows.some((row) => String(row['会商编号'] ?? '') === consultNo)) {
    return false
  }
  const adjustment: EntryRow = {
    id: nextId(rows),
    status: '待调整',
    pending: true,
    abnormal: false,
    配置编号: `WARN-${consultNo}`,
    站点编号: consultation['站点编号'],
    监测类型: '水位',
    蓝色阈值: consultation['蓝色门槛'],
    黄色阈值: consultation['黄色门槛'],
    橙色阈值: consultation['橙色门槛'],
    红色阈值: consultation['红色门槛'],
    生效状态: '待调整',
    会商编号: consultNo,
    建议等级: consultation['自动建议'],
    来源: '水位会商',
  }
  saveRows(WARNING_KEY, [...rows, adjustment])
  return true
}

export function decideConsultation(
  id: number,
  opinion: ConsultationOpinion,
  reason: string,
  operator: string,
): ActionResult {
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '请先填写处理理由，会商结论必须可追溯' }
  }
  refreshRows()
  const rows = listRows(CONSULTATION_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的会商记录` }
  }
  const current = rows[index]
  if (String(current.status) !== '待会商') {
    return { ok: false, message: `会商 ${current['会商编号']} 已有「${current.status}」结论，重复提交未生效` }
  }
  const conflict = opinion === '驳回'
  const updated: EntryRow = {
    ...current,
    status: opinion === '采纳' ? '已采纳' : '已驳回',
    pending: false,
    abnormal: conflict,
    人工意见: opinion,
    处理理由: trimmed,
    值班员: operator,
    会商时间: formatNow(),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(CONSULTATION_KEY, next)
  let message = `会商 ${current['会商编号']} 已${opinion}`
  if (opinion === '采纳') {
    message += ensureWarningAdjustment(updated) ? '，已在预警阈值补「待调整」记录' : '，预警阈值已存在对应待调整记录'
  } else {
    message += '，与自动建议冲突，以人工意见为准并已留痕'
  }
  return { ok: true, message }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
