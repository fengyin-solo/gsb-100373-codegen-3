<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel-block">
      <header class="page-head">
        <div>
          <h3>阈值会商记录</h3>
          <p class="page-desc">
            按阈值范围自动判定生成建议，值班员会商后人工结论优先落库；会商只保存快照，不改写原水位记录。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn primary" type="button" @click="buildConsult">生成/回放会商</button>
        </div>
      </header>

      <table class="data-table">
        <thead>
          <tr>
            <th>会商编号</th>
            <th>站点编号</th>
            <th>当前水位</th>
            <th>警戒/保证门槛</th>
            <th>门槛来源</th>
            <th>自动建议</th>
            <th>人工结论</th>
            <th>会商理由</th>
            <th>版本</th>
            <th>状态</th>
            <th>会商操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in consultRows" :key="String(row.会商编号)">
            <td>{{ row.会商编号 }}</td>
            <td>{{ row.站点编号 }}</td>
            <td>{{ row.当前水位 }}</td>
            <td>{{ row.警戒水位 }} / {{ row.保证水位 }}</td>
            <td>{{ row.门槛来源 }}</td>
            <td>
              <span class="level-tag" :data-level="row.自动等级">{{ row.自动等级 }}</span>
              {{ row.自动建议 }}
            </td>
            <td>
              {{ row.人工结论 }}
              <span v-if="row.冲突标记 === '人工改判'" class="conflict-tag">人工改判</span>
            </td>
            <td>
              <input
                class="reason-input"
                :value="reasons[String(row.记录编号)] ?? row.会商理由"
                :placeholder="row.status === '待会商' ? '填写采纳或驳回理由' : '改判请填写新理由'"
                @input="onReasonInput(String(row.记录编号), $event)"
              />
            </td>
            <td>v{{ row.会商版本 }}</td>
            <td>{{ row.status }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="submitConsult(row, '采纳')">采纳</button>
              <button class="link" type="button" @click="submitConsult(row, '驳回')">驳回</button>
            </td>
          </tr>
          <tr v-if="!consultRows.length">
            <td colspan="11" class="empty-state">暂无会商记录，点击「生成/回放会商」按阈值规则生成</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ consultRows.length }} 份会商 · 待会商 {{ pendingConsultCount }} 份</span>
        <span v-if="consultMessage" class="info-text">{{ consultMessage }}</span>
      </footer>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  buildConsultations,
  listConsultations,
  submitConsultation,
  type ConsultDecision,
} from '@/api/consultation-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "水位变幅", "记录状态"]
const actions = ["提交审核", "确认通过", "标记异常"]
const statuses = ["已采集", "待审核", "已通过", "异常值"]
const stats = [{"label": "今日采集数", "value": 0}, {"label": "超警戒站次", "value": 0}, {"label": "待审核记录", "value": 0}]

const store = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const consultRows = ref<EntryRow[]>([])
const consultMessage = ref('')
const reasons = ref<Record<string, string>>({})
const pendingConsultCount = computed(
  () => consultRows.value.filter((row) => String(row.status) === '待会商').length,
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '水位记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function onReasonInput(recordNo: string, event: Event) {
  reasons.value[recordNo] = (event.target as HTMLInputElement).value
}

function buildConsult() {
  const result = buildConsultations()
  consultMessage.value = result.message
  reloadConsult()
}

function submitConsult(row: EntryRow, decision: ConsultDecision) {
  consultMessage.value = ''
  const recordNo = String(row.记录编号)
  const reason = reasons.value[recordNo] ?? String(row.会商理由 ?? '')
  const result = submitConsultation(recordNo, decision, reason, store.operator)
  consultMessage.value = result.message
  if (result.ok) {
    delete reasons.value[recordNo]
  }
  reloadConsult()
}

function reloadConsult() {
  consultRows.value = listConsultations()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadConsult()
})
</script>
