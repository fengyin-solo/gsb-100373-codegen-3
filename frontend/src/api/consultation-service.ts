import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 水位阈值会商：会商记录是独立数据域（key = consultation），与水位记录、阈值配置并列持久化。
// 页面不直接读写，全部走这里；会商只保存快照，绝不回写原水位记录。
const CONSULT_KEY = 'consultation'

export type ConsultDecision = '采纳' | '驳回'

export type BuildResult = ActionResult & { created: number; skipped: number }

// 会商状态：待会商 → 已采纳 / 已驳回 →（预警页落实调整）→ 已落实
const STATUS_PENDING = '待会商'
const STATUS_ADOPTED = '已采纳'
const STATUS_REJECTED = '已驳回'
const STATUS_RESOLVED = '已落实'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function parseLevel(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) {
    return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

type Thresholds = { 警戒: number; 保证: number; 来源: string }

// 门槛解析：记录自带门槛优先；存量缺门槛的沿用该站点在预警阈值模块的已生效配置
// （橙色阈值→警戒水位，红色阈值→保证水位），并在会商记录里注明来源以便追溯。
function resolveThresholds(row: EntryRow): Thresholds | null {
  const warn = parseLevel(row['警戒水位'])
  const guarantee = parseLevel(row['保证水位'])
  if (warn !== null && guarantee !== null) {
    return { 警戒: warn, 保证: guarantee, 来源: '记录自带' }
  }
  const config = listRows('warning').find(
    (item) =>
      String(item['站点编号']) === String(row['站点编号']) && String(item.status) === '已生效',
  )
  if (!config) {
    return null
  }
  const configWarn = parseLevel(config['橙色阈值'])
  const configGuarantee = parseLevel(config['红色阈值'])
  if (configWarn === null || configGuarantee === null) {
    return null
  }
  return { 警戒: configWarn, 保证: configGuarantee, 来源: `站点原配置(${config['配置编号']})` }
}

type Verdict = { 等级: string; 建议: string; 需调整: boolean }

// 会商规则：按阈值范围划分三个区间，命中哪个区间就给哪级建议。
function judge(current: number, warn: number, guarantee: number): Verdict {
  if (current >= guarantee) {
    return { 等级: '红色', 建议: '超保证水位，建议上调门槛并启动应急响应', 需调整: true }
  }
  if (current >= warn) {
    return { 等级: '橙色', 建议: '超警戒水位，建议复核各级阈值', 需调整: true }
  }
  return { 等级: '蓝色', 建议: '水位低于警戒，建议维持现阈值', 需调整: false }
}

function nextConsultNo(rows: EntryRow[]): string {
  const used = rows
    .map((row) => /^CONS-(\d+)$/.exec(String(row['会商编号'] ?? '')))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
  const next = (used.length ? Math.max(...used) : 0) + 1
  return `CONS-${String(next).padStart(4, '0')}`
}

export function listConsultations(): EntryRow[] {
  return clone(listRows(CONSULT_KEY))
}

// 生成/回放会商：对每条水位记录按规则出一份自动建议。
// 幂等：同一记录编号只生成一份，重复回放不新增、也不覆盖已有人工结论。
export function buildConsultations(): BuildResult {
  const rows = listRows(CONSULT_KEY)
  const existing = new Set(rows.map((row) => String(row['记录编号'])))
  const waterlevels = listRows('waterlevel')
  let created = 0
  let skipped = 0
  for (const wl of waterlevels) {
    const recordNo = String(wl['记录编号'])
    if (existing.has(recordNo)) {
      skipped += 1
      continue
    }
    const thresholds = resolveThresholds(wl)
    if (!thresholds) {
      // 记录缺门槛且站点没有已生效配置：无法按标准判定，跳过并在结果里说明
      skipped += 1
      continue
    }
    const current = parseLevel(wl['当前水位'])
    if (current === null) {
      skipped += 1
      continue
    }
    const verdict = judge(current, thresholds.警戒, thresholds.保证)
    rows.push({
      id: rows.length + 1,
      status: STATUS_PENDING,
      pending: true,
      abnormal: false,
      会商编号: nextConsultNo(rows),
      记录编号: recordNo,
      站点编号: String(wl['站点编号'] ?? ''),
      观测时间: String(wl['观测时间'] ?? ''),
      当前水位: current,
      警戒水位: thresholds.警戒,
      保证水位: thresholds.保证,
      门槛来源: thresholds.来源,
      自动等级: verdict.等级,
      自动建议: verdict.建议,
      自动需调整: verdict.需调整,
      人工结论: '—',
      最终结论: '—',
      会商理由: '',
      冲突标记: '—',
      值班员: '',
      会商时间: '',
      会商版本: 1,
      结论历史: '[]',
    })
    existing.add(recordNo)
    created += 1
  }
  saveRows(CONSULT_KEY, rows)
  return {
    ok: true,
    created,
    skipped,
    message:
      created > 0
        ? `新生成 ${created} 份会商，${skipped} 条记录沿用已有会商不重复判定`
        : `没有新增会商：${skipped} 条记录已有会商或缺门槛，回放不产生新结论`,
  }
}

// 值班员提交会商结论。处理顺序：自动建议先落档 → 人工结论优先生效，
// 人工与自动不一致（驳回）即冲突，打标留痕，最终以人工结论为准。
// 幂等：同一条会商重复提交相同结论与理由（含并发重试）只留一份，不升版本、不追加历史。
export function submitConsultation(
  recordNo: string,
  decision: ConsultDecision,
  reason: string,
  operator: string,
): ActionResult {
  const rows = listRows(CONSULT_KEY)
  const index = rows.findIndex((row) => String(row['记录编号']) === recordNo)
  if (index < 0) {
    return { ok: false, message: `没有找到记录编号为 ${recordNo} 的会商，请先生成会商` }
  }
  const row = rows[index]
  const trimmed = reason.trim()
  if (!trimmed) {
    return { ok: false, message: '请先填写采纳或驳回的理由再提交会商' }
  }
  if (row.status !== STATUS_PENDING && row['人工结论'] === decision && row['会商理由'] === trimmed) {
    return { ok: true, message: `会商 ${row['会商编号']} 已登记过相同结论，重复提交只保留一份` }
  }
  const autoAdjust = row['自动需调整'] === true
  // 人工采纳 → 最终结论沿用自动建议；人工驳回 → 最终结论取反，以人工为准
  const finalAdjust = decision === '采纳' ? autoAdjust : !autoAdjust
  const conflict = decision === '驳回'
  const history = JSON.parse(String(row['结论历史'] || '[]')) as Record<string, unknown>[]
  const version =
    row.status === STATUS_PENDING ? Number(row['会商版本']) : Number(row['会商版本']) + 1
  history.push({
    结论: decision,
    理由: trimmed,
    值班员: operator,
    时间: nowText(),
    版本: version,
  })
  rows[index] = {
    ...row,
    status: decision === '采纳' ? STATUS_ADOPTED : STATUS_REJECTED,
    pending: finalAdjust,
    abnormal: conflict,
    人工结论: decision,
    最终结论: finalAdjust ? '需调整阈值' : '维持现阈值',
    会商理由: trimmed,
    冲突标记: conflict ? '人工改判' : '人机一致',
    值班员: operator,
    会商时间: nowText(),
    会商版本: version,
    结论历史: JSON.stringify(history),
  }
  saveRows(CONSULT_KEY, rows)
  return {
    ok: true,
    message: conflict
      ? `会商 ${row['会商编号']} 已按人工结论落库（与自动建议冲突，已打标留痕）`
      : `会商 ${row['会商编号']} 已提交，结论：${decision}`,
  }
}

// 预警页待调整清单：最终结论为「需调整阈值」且尚未落实的会商。
export function pendingAdjustments(): EntryRow[] {
  return listConsultations().filter(
    (row) =>
      row['最终结论'] === '需调整阈值' &&
      (row.status === STATUS_ADOPTED || row.status === STATUS_REJECTED),
  )
}

// 预警页确认阈值已调整：会商转入「已落实」，从待调整清单移除。重复落实幂等。
export function resolveConsultation(recordNo: string, operator: string): ActionResult {
  const rows = listRows(CONSULT_KEY)
  const index = rows.findIndex((row) => String(row['记录编号']) === recordNo)
  if (index < 0) {
    return { ok: false, message: `没有找到记录编号为 ${recordNo} 的会商` }
  }
  const row = rows[index]
  if (row.status === STATUS_RESOLVED) {
    return { ok: true, message: `会商 ${row['会商编号']} 已落实过，不重复处理` }
  }
  if (row['最终结论'] !== '需调整阈值') {
    return { ok: false, message: `会商 ${row['会商编号']} 的结论是维持现阈值，无需落实调整` }
  }
  const history = JSON.parse(String(row['结论历史'] || '[]')) as Record<string, unknown>[]
  history.push({ 结论: '落实调整', 理由: '预警阈值已按会商结论调整', 值班员: operator, 时间: nowText(), 版本: Number(row['会商版本']) })
  rows[index] = {
    ...row,
    status: STATUS_RESOLVED,
    pending: false,
    结论历史: JSON.stringify(history),
  }
  saveRows(CONSULT_KEY, rows)
  return { ok: true, message: `会商 ${row['会商编号']} 已落实，阈值调整完成` }
}
