<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

/* ----------------------------- Types ----------------------------- */
type Row = { name: string; profileUrl: string; avatarUrl: string }

/* --------------------------- UI State ---------------------------- */
const fileInput = ref<HTMLInputElement|null>(null)
const rows = ref<Row[]>([])
const parsing = ref(false)
const resolving = ref(false)
const progress = reactive({ done: 0, total: 0 })

/* ------------------------- User Options -------------------------- */
// Persist worker URL & avatar size in localStorage
const LS_WORKER = 'ig_avatar_worker_url_v1'
const LS_CACHE  = 'ig_avatar_cache_v1'
const LS_SIZE   = 'ig_avatar_size_v1'

const opts = reactive({
  // Put your Cloudflare Worker base URL here (no trailing slash), ex:
  // https://my-ig-proxy.workers.dev
  workerUrl: localStorage.getItem(LS_WORKER) || '',
  size: Number(localStorage.getItem(LS_SIZE) || 128) || 128,
})

function saveOpts() {
  localStorage.setItem(LS_WORKER, opts.workerUrl.trim())
  localStorage.setItem(LS_SIZE, String(opts.size))
}

/* -------------------------- Avatar Cache ------------------------- */
const avatarCache = reactive<Record<string,string>>(
  JSON.parse(localStorage.getItem(LS_CACHE) || '{}')
)
function saveCache() { localStorage.setItem(LS_CACHE, JSON.stringify(avatarCache)) }

/* ---------------------------- Helpers ---------------------------- */

// Simple HSL→RGB for pretty placeholders
function hslToRgb(h:number, s:number, l:number){
  const c=(1-Math.abs(2*l-1))*s, hp=h/60, x=c*(1-Math.abs((hp%2)-1))
  let [r,g,b]=[0,0,0]
  if (0<=hp&&hp<1) [r,g,b]=[c,x,0]
  else if (1<=hp&&hp<2) [r,g,b]=[x,c,0]
  else if (2<=hp&&hp<3) [r,g,b]=[0,c,x]
  else if (3<=hp&&hp<4) [r,g,b]=[0,x,c]
  else if (4<=hp&&hp<5) [r,g,b]=[x,0,c]
  else if (5<=hp&&hp<6) [r,g,b]=[c,0,x]
  const m=l-c/2
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)]
}

// Deterministic nice-looking placeholder
function placeholderAvatar(seed:string, size=128){
  const [r,g,b] = hslToRgb((seed.length*47)%360, 0.55, 0.62)
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/${size}`
}

function imgSrc(r: Row){
  const base = opts.workerUrl.trim().replace(/\/+$/,'')
  const user = usernameFromProfileUrl(r.profileUrl)
  if (base && user) return `${base}/redirect?u=${encodeURIComponent(user)}&size=${opts.size}`
  return r.avatarUrl || placeholderAvatar(r.name, 64)
}

// Download helper
function downloadText(filename:string, text:string){
  const blob = new Blob([text], {type:'application/json'})
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// Concurrency limiter
async function pLimit<T>(n:number, tasks: (()=>Promise<T>)[]) {
  const results: T[] = new Array(tasks.length) as any
  let i = 0, running = 0
  return new Promise<T[]>((res, rej)=>{
    const next = ()=>{
      if (i >= tasks.length && running === 0) return res(results)
      while (running < n && i < tasks.length) {
        const cur = i++
        running++
        tasks[cur]().then(v=>{ results[cur]=v }).catch(rej).finally(()=>{ running--; next() })
      }
    }
    next()
  })
}

function usernameFromProfileUrl(url:string){
  try {
    const u = new URL(url)
    const segs = u.pathname.replace(/^\/+|\/+$/g,'').split('/').filter(Boolean)
    return segs[0] || ''
  } catch { return '' }
}

/* ---------------------------- Parsing ---------------------------- */
/** Parse single Instagram-export HTML to rows */
function parseInstagramFollowersHtml(html: string): Row[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const anchors = Array.from(
    doc.querySelectorAll('a[href^="https://www.instagram.com/"]')
  ) as HTMLAnchorElement[]

  // Exclude known non-profile paths
  const BAD = new Set(['accounts','direct','p','explore','reels','stories','challenge','sessions','about','legal','privacy'])

  const out: Row[] = []
  for (const a of anchors) {
    let url: URL
    try { url = new URL(a.href) } catch { continue }
    if (url.hostname !== 'www.instagram.com') continue

    const segs = url.pathname.split('/').filter(Boolean)
    if (!segs.length) continue
    const user = segs[0]
    if (!user || BAD.has(user.toLowerCase())) continue

    // Name = anchor text or username
    const name = (a.textContent || user).trim()
    const profileUrl = `https://www.instagram.com/${user}/`

    const workerBase = (opts.workerUrl || '').trim().replace(/\/+$/, '')
    const avatarUrl = workerBase
      ? `${workerBase}/image?u=${encodeURIComponent(user)}&size=${opts.size}`
      // fallback if worker URL is not set yet
      : `https://unavatar.io/instagram/${encodeURIComponent(user)}.png?size=${opts.size}`

    out.push({ name, avatarUrl, profileUrl })
  }
  return out
}

/** Handle <input type=file multiple> */
async function onFilesChange(e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files || !files.length) return

  parsing.value = true
  const seen = new Set<string>()
  const all: Row[] = []

  try {
    for (const f of Array.from(files)) {
      const html = await f.text()
      const part = parseInstagramFollowersHtml(html)
      for (const r of part) {
        const key = (usernameFromProfileUrl(r.profileUrl) || r.profileUrl).toLowerCase()
        if (!seen.has(key)) { seen.add(key); all.push(r) }
      }
    }
    all.sort((a,b)=>a.name.localeCompare(b.name, undefined, {sensitivity:'base'}))
    rows.value = all
  } finally {
    parsing.value = false
    if (fileInput.value) fileInput.value.value = ''
  }
}

/* ----------------------- Resolve Real Avatars -------------------- */
/** Fetch avatar via your Cloudflare Worker: /avatar?u=USERNAME */
async function resolveAvatars() {
  saveOpts()
  const base = opts.workerUrl.trim().replace(/\/+$/,'')
  if (!base) { alert('Please set Avatar proxy URL first.'); return }
  if (!rows.value.length) return

  resolving.value = true
  progress.done = 0
  progress.total = rows.value.length

  const tasks = rows.value.map(row => async ()=>{
    const user = usernameFromProfileUrl(row.profileUrl)
    if (!user) { progress.done++; return row }

    const cached = avatarCache[user]
    if (cached) {
      row.avatarUrl = cached
      progress.done++
      return row
    }

    try {
      const r = await fetch(`${base}/avatar?u=${encodeURIComponent(user)}`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
      })
      if (!r.ok) throw new Error('bad status '+r.status)
      const j = await r.json()
      const real = j?.url as string | undefined
      if (real && typeof real === 'string') {
        row.avatarUrl = real
        avatarCache[user] = real
        saveCache()
      } else {
        row.avatarUrl = placeholderAvatar(user, opts.size)
      }
    } catch {
      row.avatarUrl = placeholderAvatar(user, opts.size)
    } finally {
      progress.done++
    }

    return row
  })

  await pLimit(8, tasks)
  resolving.value = false
}

/* --------------------------- Export JSON ------------------------- */
const jsonOut = computed(()=> JSON.stringify(rows.value, null, 2))
function downloadJson(){ downloadText('followers.json', jsonOut.value) }
function clearAll(){ rows.value = [] }

onMounted(()=>{
  // minor UX nicety
  setTimeout(()=> fileInput.value?.focus(), 0)
})
</script>

<template>
  <div class="bg-[#0b1020] min-h-screen text-slate-200">
    <div class="mx-auto p-4 md:p-6">
      <header class="flex flex-wrap justify-between items-center gap-3 mb-4">
        <h1 class="font-bold text-2xl md:text-3xl tracking-tight">Instagram → JSON (followers)</h1>
        <div class="flex gap-2">
          <button @click="downloadJson" :disabled="!rows.length"
                  class="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 rounded-2xl">
            Download JSON
          </button>
          <button @click="clearAll" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-2xl">Clear</button>
        </div>
      </header>

      <div class="gap-4 grid grid-cols-1 lg:grid-cols-3">
        <!-- Left: Controls -->
        <section class="space-y-4 lg:col-span-1">
          <!-- Upload -->
          <div class="bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="mb-3 font-semibold">Upload export HTML</h2>
            <p class="mb-3 text-slate-400 text-sm">Drop one or more Instagram export HTML files (followers).</p>
            <label class="inline-flex items-center bg-slate-700/70 hover:bg-slate-600/70 px-3 py-2 rounded-xl cursor-pointer">
              <input ref="fileInput" type="file" accept=".html,.htm" multiple class="hidden" @change="onFilesChange" />
              Choose files
            </label>
            <div v-if="parsing" class="mt-2 text-slate-400 text-xs">Parsing…</div>
          </div>

          <!-- Proxy & avatar -->
          <div class="space-y-3 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="font-semibold">Real avatars</h2>
            <p class="text-slate-400 text-sm">Set your Cloudflare Worker base URL (no trailing slash).</p>
            <input
              type="url"
              v-model.trim="opts.workerUrl"
              @change="saveOpts"
              placeholder="https://your-worker-subdomain.workers.dev"
              class="bg-slate-900/70 p-2 border border-slate-700/50 rounded-xl w-full text-sm"
            />

            <div class="flex items-center gap-3 pt-2 text-sm">
              <label class="opacity-70">Avatar size</label>
              <input type="number" v-model.number="opts.size" min="32" max="512"
                     @change="saveOpts"
                     class="bg-slate-900/70 px-2 py-1 border border-slate-700/50 rounded w-24">
            </div>

            <button @click="resolveAvatars"
                    :disabled="resolving || !rows.length || !opts.workerUrl"
                    class="bg-slate-700/70 hover:bg-slate-600/70 disabled:opacity-40 px-3 py-2 rounded-xl">
              Resolve avatars
            </button>
            <div v-if="resolving" class="text-slate-400 text-xs">
              Resolving {{ progress.done }} / {{ progress.total }}…
            </div>

            <p class="text-slate-500 text-xs">
              Tip: Worker endpoint implements <code>/avatar?u=username</code> and returns JSON with the real image URL.
            </p>
          </div>

          <!-- Export preview -->
          <div class="bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="font-semibold">Export</h2>
            <p class="mb-2 text-slate-400 text-xs">Preview ({{ rows.length }} entries):</p>
            <textarea readonly class="bg-slate-900/70 p-2 border border-slate-700/50 rounded-xl w-full h-40 text-xs">{{ jsonOut }}</textarea>
          </div>
        </section>

        <!-- Right: Cards -->
        <section class="space-y-4 lg:col-span-2">
          <div class="bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="mb-3 font-semibold">Followers</h2>
            <div v-if="!rows.length" class="text-slate-400 text-sm">No data yet. Upload your HTML files.</div>
            <div v-else class="gap-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
              <article v-for="(r,i) in rows" :key="r.profileUrl+i"
                       class="flex items-center gap-3 bg-slate-900/60 p-3 border border-slate-700/40 rounded-xl">
                <img
                  :src="imgSrc(r)"
                  :alt="r.name"
                  class="bg-slate-700/60 rounded-full w-12 h-12 object-cover"
                  @error="(e:any)=>{ e.target.src = placeholderAvatar(r.name, 64) }"
                />
                <div class="min-w-0">
                  <div class="font-semibold truncate">{{ r.name }}</div>
                  <a :href="r.profileUrl" target="_blank" class="text-emerald-400 text-sm hover:underline truncate">
                    {{ r.profileUrl }}
                  </a>
                </div>
              </article>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
