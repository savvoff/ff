<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useLocalStorage } from '@/composables/useLocalStorage' // your existing composable

/* -------------------- Types -------------------- */
type RawRow = { name?: string; profileUrl?: string; avatarUrl?: string }
type Row = { name: string; profileUrl: string; avatarUrl: string }

/* -------------------- State -------------------- */
const files = ref<File[]>([])
const rows = ref<Row[]>([])
const loading = ref(false)
const errorMsg = ref<string | undefined>(undefined)

/** UI state with localStorage persistence */
const defaultUI = {
  workerBase: '',
  useWorkerAvatars: true,
  q: '',
  sortKey: 'name' as 'name' | 'profileUrl',
  sortDir: 'asc' as 'asc' | 'desc',
  page: 1,
  pageSize: 100,
}
const uiStore = useLocalStorage('parser.ui', defaultUI)
/** keep it reactive even if composable returns plain ref/object */
const ui = reactive(uiStore.value ?? { ...defaultUI })

/** persist on change */
watch(ui, (v) => {
  uiStore.value = JSON.parse(JSON.stringify(v))
}, { deep: true })

/* -------------------- Utils -------------------- */
// Accept only https origins; allow workers.dev or custom domain
function toHttpsOrigin(s: string): string {
  try {
    const u = new URL(s.trim())
    if (u.protocol !== 'https:') return ''
    // return normalized origin without trailing path/query
    return u.origin
  } catch { return '' }
}
const workerOrigin = computed(() => toHttpsOrigin(ui.workerBase))
const isWorkerConfigured = computed(() => ui.useWorkerAvatars && !!workerOrigin.value)

function slugFromProfile(url?: string) {
  if (!url) return ''
  try {
    const u = new URL(url)
    return u.pathname.split('/').filter(Boolean)[0] || ''
  } catch { return '' }
}
function ensureName(r: RawRow, i: number) {
  const n = (r.name || '').trim()
  if (n) return n
  const s = slugFromProfile(r.profileUrl)
  return s || `user_${i+1}`
}
function buildAvatarUrl(name: string, profileUrl: string, current: string) {
  // If JSON already has avatarUrl and user wants to keep it — keep it
  if (current) return current
  // If worker avatars requested but misconfigured — do not fabricate URL
  if (!isWorkerConfigured.value) return ''
  const username = name || slugFromProfile(profileUrl)
  if (!username) return ''
  return `${workerOrigin.value}/image?u=${encodeURIComponent(username)}&size=128`
}
function placeholderAvatar(seed:string, size=128){
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${size}`
}

function onImgError(ev: Event) {
  const img = ev.target as HTMLImageElement
  if (!img || img.dataset.fbk === '1') return // avoid loops
  img.dataset.fbk = '1'
  img.src = 'placeholder.jpg'
}

/* -------------------- Parsing -------------------- */
async function parseFiles(selected: File[]) {
  loading.value = true
  errorMsg.value = undefined
  try {
    const out: Row[] = []
    const seen = new Set<string>()
    for (let idx = 0; idx < selected.length; idx++) {
      const f = selected[idx]
      const text = await f.text()

      // JSON-ish quick guard
      if (f.name.endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')) {
        try {
          const data = JSON.parse(text)

          // Typical IG export: array with string_list_data
          if (Array.isArray(data)) {
            for (let i = 0; i < data.length; i++) {
              const item = data[i]
              const sld = item?.string_list_data?.[0]
              const n = ensureName({ name: sld?.value, profileUrl: sld?.href }, out.length)
              const p = sld?.href || (item?.href ?? `https://www.instagram.com/${n}/`)
              const key = n.toLowerCase()
              if (key && !seen.has(key)) {
                seen.add(key)
                out.push({
                  name: n,
                  profileUrl: p,
                  avatarUrl: buildAvatarUrl(n, p, ''),
                })
              }
            }
            continue
          }

          // Flat export shape: { followers: [...] } or { rows: [...] }
          if (Array.isArray(data?.followers ?? data?.rows)) {
            const arr: RawRow[] = (data.followers ?? data.rows) as any
            for (let i = 0; i < arr.length; i++) {
              const r = arr[i]
              const n = ensureName(r, out.length)
              const p = r.profileUrl || `https://www.instagram.com/${n}/`
              const key = n.toLowerCase()
              if (!seen.has(key)) {
                seen.add(key)
                out.push({
                  name: n,
                  profileUrl: p,
                  avatarUrl: buildAvatarUrl(n, p, r.avatarUrl || ''),
                })
              }
            }
            continue
          }
        } catch {
          // fallthrough to HTML parse
        }
      }

      // HTML export (followers_*.html)
      const doc = new DOMParser().parseFromString(text, 'text/html')
      const anchors = Array.from(doc.querySelectorAll('a[href*="instagram.com/"]')) as HTMLAnchorElement[]
      for (let a of anchors) {
        const href = a.getAttribute('href') || ''
        const n = ensureName({ name: a.textContent || '', profileUrl: href }, out.length)
        const p = href || `https://www.instagram.com/${n}/`
        const key = n.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          out.push({
            name: n,
            profileUrl: p,
            avatarUrl: buildAvatarUrl(n, p, ''),
          })
        }
      }
    }
    rows.value = out
    ui.page = 1
  } catch (e: any) {
    errorMsg.value = String(e?.message || e)
  } finally {
    loading.value = false
  }
}

/* -------------------- File handlers -------------------- */
function onFiles(e: Event) {
  const input = e.currentTarget as HTMLInputElement
  const fs = Array.from(input.files || [])
  files.value = fs
  if (fs.length) parseFiles(fs)
  input.value = ''
}
function onDrop(e: DragEvent) {
  e.preventDefault()
  const fs = Array.from(e.dataTransfer?.files || [])
  files.value = fs
  if (fs.length) parseFiles(fs)
}
function onDragOver(e: DragEvent) { e.preventDefault() }

/* -------------------- Table / Pagination -------------------- */
const filtered = computed(() => {
  const q = ui.q.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter(r =>
    r.name.toLowerCase().includes(q) ||
    r.profileUrl.toLowerCase().includes(q)
  )
})
const sorted = computed(() => {
  const arr = filtered.value.slice()
  const k = ui.sortKey
  const dir = ui.sortDir === 'asc' ? 1 : -1
  arr.sort((a, b) => {
    const av = (a as any)[k] || ''
    const bv = (b as any)[k] || ''
    return String(av).localeCompare(String(bv)) * dir
  })
  return arr
})
const total = computed(() => sorted.value.length)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / ui.pageSize)))
const page = computed({
  get: () => Math.min(ui.page, totalPages.value),
  set: (v: number) => ui.page = Math.min(Math.max(1, v), totalPages.value),
})
const pageSlice = computed(() => {
  const start = (page.value - 1) * ui.pageSize
  const end = start + ui.pageSize
  return sorted.value.slice(start, end)
})
function nextPage() { page.value = page.value + 1 }
function prevPage() { page.value = page.value - 1 }
function setSort(k: 'name' | 'profileUrl') {
  if (ui.sortKey === k) ui.sortDir = ui.sortDir === 'asc' ? 'desc' : 'asc'
  else { ui.sortKey = k; ui.sortDir = 'asc' }
}

/* -------------------- Export -------------------- */
function downloadJSON() {
  const blob = new Blob([JSON.stringify(rows.value, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `followers_${rows.value.length}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <div class="bg-[#0b1020] min-h-screen text-slate-200">
    <div class="mx-auto p-4 md:p-6">
      <header class="flex justify-between items-center gap-4 mb-4">
        <h1 class="font-bold text-2xl md:text-3xl tracking-tight">Followers Parser</h1>
        <div class="flex gap-2">
          <button
            class="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 rounded-2xl"
            :disabled="!rows.length"
            @click="downloadJSON">
            Export JSON ({{ rows.length }})
          </button>
        </div>
      </header>

      <!-- Controls -->
      <section class="gap-4 grid lg:grid-cols-3 mb-4">
        <div class="lg:col-span-2 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
          <h2 class="mb-3 font-semibold">Import</h2>
          <div
            class="hover:bg-slate-800/40 p-6 border-2 border-slate-600/70 border-dashed rounded-xl text-center cursor-pointer"
            @drop="onDrop" @dragover="onDragOver">
            <input type="file" class="hidden" id="fileInp" multiple accept=".html,.json,.txt"
                   @change="onFiles">
            <label for="fileInp" class="inline-flex bg-slate-700/60 hover:bg-slate-600/60 px-4 py-2 rounded-xl">
              Select / Drop files (.html / .json)
            </label>
            <div class="mt-2 text-slate-400 text-sm">You can drop multiple Instagram export files.</div>
          </div>

          <div v-if="errorMsg" class="mt-3 text-rose-400 text-sm">{{ errorMsg }}</div>
          <div v-if="loading" class="mt-3 text-slate-300 text-sm">Parsing…</div>
        </div>

        <div class="space-y-3 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
          <h2 class="font-semibold">Avatar source</h2>
          <label class="flex items-center gap-2">
            <input type="checkbox" v-model="ui.useWorkerAvatars" class="accent-emerald-500">
            <span>Use worker /image?u=…</span>
          </label>
          <input
            v-model.trim="ui.workerBase"
            placeholder="https://<your-worker>.workers.dev"
            class="bg-slate-900/70 px-3 py-2 border border-slate-700/50 rounded-lg w-full text-sm"
          />
          <p class="text-slate-400 text-xs">
            This is persisted to localStorage. We only accept HTTPS origins.
          </p>
          <div v-if="ui.useWorkerAvatars && !isWorkerConfigured" class="text-amber-300 text-xs">
            Worker URL is missing or invalid (must be an HTTPS origin). Avatar URLs will be left blank.
          </div>
        </div>
      </section>

      <!-- Toolbar -->
      <section class="flex flex-wrap items-center gap-3 bg-slate-800/60 mb-3 p-3 border border-slate-700/50 rounded-2xl">
        <input
          v-model.trim="ui.q"
          placeholder="Search username or URL…"
          class="bg-slate-900/70 px-3 py-2 border border-slate-700/50 rounded-lg w-60 text-sm"
          @input="ui.page = 1"
        />
        <div class="flex items-center gap-2 text-sm">
          <span class="opacity-70">Sort:</span>
          <button
            class="bg-slate-700/60 hover:bg-slate-600/60 px-2 py-1 rounded-lg"
            @click="setSort('name')">
            name <span class="opacity-60" v-if="ui.sortKey==='name'">({{ ui.sortDir }})</span>
          </button>
          <button
            class="bg-slate-700/60 hover:bg-slate-600/60 px-2 py-1 rounded-lg"
            @click="setSort('profileUrl')">
            url <span class="opacity-60" v-if="ui.sortKey==='profileUrl'">({{ ui.sortDir }})</span>
          </button>
        </div>
        <div class="flex items-center gap-2 ml-auto text-sm">
          <span class="opacity-70">{{ ((page-1)*ui.pageSize)+1 }}–{{ Math.min(page*ui.pageSize, total) }} of {{ total }}</span>
          <select v-model.number="ui.pageSize" class="bg-slate-900/70 px-2 py-1 border border-slate-700/50 rounded-lg" @change="ui.page=1">
            <option :value="50">50</option>
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
          </select>
          <button class="bg-slate-700/60 hover:bg-slate-600/60 disabled:opacity-50 px-2 py-1 rounded-lg"
                  :disabled="page<=1" @click="prevPage()">Prev</button>
          <button class="bg-slate-700/60 hover:bg-slate-600/60 disabled:opacity-50 px-2 py-1 rounded-lg"
                  :disabled="page>=totalPages" @click="nextPage()">Next</button>
        </div>
      </section>

      <!-- Table -->
      <section class="bg-slate-800/60 border border-slate-700/50 rounded-2xl overflow-hidden">
        <div class="overflow-x-auto">
          <table class="min-w-full text-sm">
            <thead class="top-0 z-10 sticky bg-slate-800/80">
              <tr class="text-left">
                <th class="px-3 py-2 w-16">Avatar</th>
                <th class="px-3 py-2">Name</th>
                <th class="px-3 py-2">Profile</th>
                <th class="px-3 py-2">avatarUrl</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in pageSlice" :key="r.name" class="border-slate-700/40 border-t">
                <td class="px-3 py-2">
                  <img v-if="r.avatarUrl"
                       :src="r.avatarUrl"
                       loading="lazy" crossorigin="anonymous"
                       width="40" height="40"
                       class="bg-slate-300/50 border border-slate-400/30 rounded-full w-10 h-10 object-cover" 
                       @error="onImgError"/>
                  <img v-else
                       :src="placeholderAvatar(r.name)"
                       loading="lazy" crossorigin="anonymous"
                       width="40" height="40"
                       class="bg-slate-300/50 border border-slate-400/30 rounded-full w-10 h-10 object-cover" />
                </td>
                <td class="px-3 py-2 font-medium">{{ r.name }}</td>
                <td class="px-3 py-2">
                  <a :href="r.profileUrl" target="_blank" class="text-emerald-400 hover:underline break-all">
                    {{ r.profileUrl }}
                  </a>
                </td>
                <td class="px-3 py-2 text-slate-300 break-all">
                  {{ r.avatarUrl || '—' }}
                </td>
              </tr>
              <tr v-if="!loading && pageSlice.length===0">
                <td colspan="4" class="px-3 py-6 text-slate-400 text-center">No data</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>
