<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">维护预警阈值配置，围绕配置编号、站点编号、监测类型、蓝色阈值做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据，可先登记预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="panel-block">
      <header class="page-head">
        <div>
          <h3>待调整记录</h3>
          <p class="page-desc">
            来自水位监测会商的结论：最终判定需调整阈值的记录汇总在此，落实调整后点击「完成调整」。
          </p>
        </div>
        <div class="page-actions">
          <button class="btn" type="button" @click="reloadAdjust">刷新待调整</button>
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
            <th>值班员</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in adjustRows" :key="String(row.会商编号)">
            <td>{{ row.会商编号 }}</td>
            <td>{{ row.站点编号 }}</td>
            <td>{{ row.当前水位 }}</td>
            <td>{{ row.警戒水位 }} / {{ row.保证水位 }}</td>
            <td>{{ row.门槛来源 }}</td>
            <td>{{ row.自动建议 }}</td>
            <td>
              {{ row.人工结论 }}
              <span v-if="row.冲突标记 === '人工改判'" class="conflict-tag">人工改判</span>
            </td>
            <td>{{ row.会商理由 }}</td>
            <td>{{ row.值班员 }}</td>
            <td class="row-actions">
              <button class="link" type="button" @click="completeAdjust(row)">完成调整</button>
            </td>
          </tr>
          <tr v-if="!adjustRows.length">
            <td colspan="10" class="empty-state">暂无待调整记录，水位会商判定需调整后会汇总到这里</td>
          </tr>
        </tbody>
      </table>

      <footer class="page-foot">
        <span>共 {{ adjustRows.length }} 条待调整记录</span>
        <span v-if="adjustMessage" class="info-text">{{ adjustMessage }}</span>
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
import { pendingAdjustments, resolveConsultation } from '@/api/consultation-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('warning')
const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "生效状态"]
const actions = ["发布生效", "调整阈值", "停用配置"]
const statuses = ["草稿", "已生效", "已调整", "已停用"]
const stats = [{"label": "配置总数", "value": 0}, {"label": "已生效数", "value": 0}, {"label": "本月调整数", "value": 0}]

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

const adjustRows = ref<EntryRow[]>([])
const adjustMessage = ref('')

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '预警阈值配置登记入口尚未接入审批流'
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

function completeAdjust(row: EntryRow) {
  adjustMessage.value = ''
  const result = resolveConsultation(String(row.记录编号), store.operator)
  adjustMessage.value = result.message
  reloadAdjust()
}

function reloadAdjust() {
  adjustRows.value = pendingAdjustments()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadAdjust()
})
</script>
