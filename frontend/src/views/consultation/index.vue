<template>
  <section class="page" data-module="consultation">
    <header class="page-head">
      <div>
        <h2>水位阈值会商</h2>
        <p class="page-desc">先列出站点、当前水位与各级门槛，再由值班员记录采纳或驳回理由；会商不改写原水位，结论留痕可追溯。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="generate">生成会商建议</button>
        <button class="btn" type="button" @click="exportRows">导出会商记录</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="draft" class="decide-panel">
      <p class="decide-title">
        正在会商：{{ draft.row['会商编号'] }}（{{ draft.row['站点编号'] }}）｜ 自动建议：{{ draft.row['自动建议'] }} ｜ 人工意见：{{ draft.opinion }}
      </p>
      <p class="decide-hint">值班员：{{ store.operator }} ｜ 会商版本：{{ draft.row['会商版本'] }}；驳回即与自动建议冲突，将以人工意见为准并留痕。</p>
      <textarea
        v-model="draft.reason"
        class="decide-reason"
        rows="3"
        placeholder="请填写采纳或驳回理由（必填，写入会商记录）"
      ></textarea>
      <div class="decide-actions">
        <button class="btn primary" type="button" @click="submitDecision">确认提交</button>
        <button class="btn ghost" type="button" @click="draft = null">取消</button>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>会商编号</th>
          <th>记录编号</th>
          <th>站点编号</th>
          <th>当前水位</th>
          <th>各级门槛（蓝/黄/橙/红）</th>
          <th>门槛来源</th>
          <th>自动建议</th>
          <th>人工意见</th>
          <th>处理理由</th>
          <th>值班员</th>
          <th>会商时间</th>
          <th>版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>{{ row['会商编号'] }}</td>
          <td>{{ row['记录编号'] }}</td>
          <td>{{ row['站点编号'] }}</td>
          <td>{{ row['当前水位'] }}</td>
          <td>{{ thresholdText(row) }}</td>
          <td>{{ row['门槛来源'] }}</td>
          <td>{{ row['自动建议'] }}</td>
          <td>{{ row['人工意见'] || '—' }}</td>
          <td>{{ row['处理理由'] || '—' }}</td>
          <td>{{ row['值班员'] || '—' }}</td>
          <td>{{ row['会商时间'] || '—' }}</td>
          <td>{{ row['会商版本'] }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormal" class="conflict-tag">冲突</span>
          </td>
          <td class="row-actions">
            <template v-if="row.status === '待会商'">
              <button class="link" type="button" @click="openDecision(row, '采纳')">采纳</button>
              <button class="link" type="button" @click="openDecision(row, '驳回')">驳回</button>
            </template>
            <span v-else class="muted-text">已留痕</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="14" class="empty-state">暂无会商记录，可点击「生成会商建议」从水位记录发起</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条会商记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  decideConsultation,
  downloadEntries,
  generateConsultations,
  listEntries,
} from '@/api/local-service'
import type { ConsultationOpinion, EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const MODULE_KEY = 'consultation'
const statuses = ['待会商', '已采纳', '已驳回']
const filterFields = ['会商编号', '站点编号', '记录编号']

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const draft = ref<{ row: EntryRow; opinion: ConsultationOpinion; reason: string } | null>(null)

const stats = computed(() => [
  { label: '待会商记录', value: rows.value.filter((row) => row.status === '待会商').length },
  { label: '已采纳记录', value: rows.value.filter((row) => row.status === '已采纳').length },
  { label: '已驳回记录', value: rows.value.filter((row) => row.status === '已驳回').length },
  { label: '冲突记录', value: rows.value.filter((row) => row.abnormal).length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function thresholdText(row: EntryRow): string {
  return ['蓝色门槛', '黄色门槛', '橙色门槛', '红色门槛']
    .map((field) => String(row[field] ?? '—'))
    .join(' / ')
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(MODULE_KEY)
}

function generate() {
  errorMessage.value = ''
  const result = generateConsultations()
  noticeMessage.value = result.message
  reload()
}

function openDecision(row: EntryRow, opinion: ConsultationOpinion) {
  errorMessage.value = ''
  draft.value = { row, opinion, reason: '' }
}

function submitDecision() {
  if (!draft.value) {
    return
  }
  const { row, opinion, reason } = draft.value
  const result = decideConsultation(Number(row.id), opinion, reason, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  draft.value = null
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(MODULE_KEY, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '会商记录读取失败'
  }
}

onMounted(reload)
</script>
