<script setup lang="ts">
// All comments in this code are in English only.
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue'
import LabeledRange from '@/components/LabeledRange.vue'
import LabeledNumber from '@/components/LabeledNumber.vue'
import { useLocalStorage } from '@/composables/useLocalStorage'
import demo from '../demo.json';

const defaultParams = {
  // visuals
  aliveCount: 200,
  radiusCss: 6,
  autoRadius: true,
  radiusScaleMax: 3.0,
  radiusScaleExp: 1.0,
  speedCss: 150,
  color: '#f3f3ff',
  bg: '#0b111a',
  ringColor: '#58b6ff',
  ringWidthPx: 2,
  minSpeedCss: 100,
  maxSpeedCss: 300,
  hitBoostPct: 5,
  wallBoostPct: 10,
  // health
  hpMax: 200,
  dmgHitMin: 6,
  dmgHitMax: 14,
  // physics
  collisions: true,
  cellSizePx: 24,
  maxPairsPerCell: 128,
  // labels
  labelsCount: 64,
  labelsSmoothMs: 150,
  labelsThrottleMs: 50,
  // fps
  fps: 60,
  paused: false,
  // auto tune
  autoTune: true,
  // GPU avatars
  gpuAvatars: true,
  avatarTilePx: 64,
}


// Load from localStorage (if exists), else use defaults
const saved = useLocalStorage('params-gpu', defaultParams)
const ui = saved.value ?? reactive(defaultParams)

const stageRef = ref<HTMLDivElement | null>(null)
const pointsRef = ref<HTMLCanvasElement | null>(null)
const labelsRef = ref<HTMLCanvasElement | null>(null)
let worker: Worker | null = null
let dpr = 1
let offscreenTransferred = false
let ro: ResizeObserver | null = null

type LabelSlot = { id: number; name: string; x: number; y: number; tx: number; ty: number; hp01: number; vis: number }
let labelSlots: LabelSlot[] = []
let rafId: number | null = null
let lastRAF = performance.now()
let lastRadiusPx = 8
let lastAliveCount = ui.aliveCount

const boot = reactive({ started: false, counting: false, counter: 0 })

const rawJsonString = JSON.stringify(demo);
const usersJson = ref(rawJsonString)
type User = { name: string; avatarUrl?: string }
const users = ref<User[]>([])

function parseUsersJSON() {
  try {
    const arr = JSON.parse(usersJson.value)
    if (Array.isArray(arr)) {
      users.value = arr.filter((x: any) => x && typeof x.name === 'string')
      buildLabelIndices()
    }
  } catch {}
}

// ---- sizing ----
function fit() {
  const stage = stageRef.value, p = pointsRef.value, l = labelsRef.value
  if (!stage || !p) return
  const rect = stage.getBoundingClientRect()
  const cssW = Math.max(1, Math.floor(rect.width))
  const cssH = Math.max(1, Math.floor(rect.height))

  dpr = Math.min(window.devicePixelRatio || 1, 2)

  p.style.width = `${cssW}px`; p.style.height = `${cssH}px`
  if (l) {
    l.style.width = `${cssW}px`; l.style.height = `${cssH}px`
    l.width = Math.floor(cssW * dpr); l.height = Math.floor(cssH * dpr)
  }
  const devW = Math.floor(cssW * dpr), devH = Math.floor(cssH * dpr)
  if (!offscreenTransferred) { p.width = devW; p.height = devH }
  worker?.postMessage({ type: 'resize', width: devW, height: devH, dpr })
}

// ---- config push ----
function hexToRgbFloats(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  const r = m ? parseInt(m[1], 16) : 255
  const g = m ? parseInt(m[2], 16) : 255
  const b = m ? parseInt(m[3], 16) : 255
  return [r / 255, g / 255, b / 255]
}
function pushConfig() {
  if (!worker) return
  worker.postMessage({
    type: 'config',
    radiusCss: ui.radiusCss,
    autoRadius: ui.autoRadius,
    radiusScaleMax: ui.radiusScaleMax,
    radiusScaleExp: ui.radiusScaleExp,
    speedCss: ui.speedCss,
    color: hexToRgbFloats(ui.color),
    bg: hexToRgbFloats(ui.bg),
    ringColor: hexToRgbFloats(ui.ringColor),
    ringWidthPx: ui.ringWidthPx,
    minSpeedCss: ui.minSpeedCss,
    maxSpeedCss: ui.maxSpeedCss,
    hitBoostMul: 1 + ui.hitBoostPct / 100,
    wallBoostMul: 1 + ui.wallBoostPct / 100,
    collisions: ui.collisions,
    cellSizePx: ui.cellSizePx,
    maxPairsPerCell: ui.maxPairsPerCell,
    hpMax: ui.hpMax,
    dmgHitMin: ui.dmgHitMin,
    dmgHitMax: ui.dmgHitMax,
  })
  worker.postMessage({ type: 'fps', maxFps: ui.fps })
}

// ---- HP helpers ----
function setAllHP() {
  if (!worker) return
  worker.postMessage({ type: 'hpSetAll', hp: ui.hpMax })
}

// ---- labels (names only) ----
function buildLabelIndices() {
  const K = Math.max(0, Math.min(ui.labelsCount, users.value.length))
  if (K === 0) {
    labelSlots = []
    if (worker) worker.postMessage({ type: 'labelsConfig', indices: [], throttleMs: ui.labelsThrottleMs, sendOnce: true })
    clearLabels()
    return
  }
  const arr = new Int32Array(K)
  for (let i = 0; i < K; i++) {
    const base = Math.floor(((i + 0.5) * ui.aliveCount) / K)
    const jitter = Math.floor((Math.random() - 0.5) * ui.aliveCount / (K * 4))
    let idx = base + jitter; if (idx < 0) idx = 0; if (idx >= ui.aliveCount) idx = ui.aliveCount - 1
    arr[i] = idx | 0
  }
  labelSlots = users.value.slice(0, K).map((u, i) => ({
    id: arr[i], name: u?.name ?? '', x: 0, y: 0, tx: 0, ty: 0, hp01: 0, vis: 0
  }))
  if (worker) {
    worker.postMessage({ type: 'labelsConfig', indices: Array.from(arr), throttleMs: ui.labelsThrottleMs, sendOnce: true })
    sendGpuAvatarsList()
  }
}
function clearLabels() {
  const c = labelsRef.value!, ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, c.width, c.height)
}
function drawLabelsFromWorker(payload: any) {
  if (!payload?.data || !labelSlots.length) return
  lastRadiusPx = payload.radiusPx || lastRadiusPx
  const arr = payload.data instanceof ArrayBuffer ? new Float32Array(payload.data) : new Float32Array(payload.data as number[])
  const K = Math.min(labelSlots.length, Math.floor(arr.length / 3))
  for (let i = 0; i < K; i++) {
    labelSlots[i].tx = arr[i * 3 + 0]
    labelSlots[i].ty = arr[i * 3 + 1]
    labelSlots[i].hp01 = arr[i * 3 + 2]
  }
}
function renderLabelsRAF() {
  const c = labelsRef.value!; const ctx = c.getContext('2d')!
  const now = performance.now(); const dt = Math.min(100, now - lastRAF); lastRAF = now
  const tau = Math.max(1, ui.labelsSmoothMs); const a = 1 - Math.exp(-dt / tau)
  ctx.clearRect(0, 0, c.width, c.height)
  const pad = Math.max(2, Math.floor(4 * dpr)), fontPx = Math.max(10, Math.floor(12 * dpr))
  ctx.font = `${fontPx}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial`
  ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'
  for (const s of labelSlots) {
    s.x += (s.tx - s.x) * a
    s.y += (s.ty - s.y) * a
    const vTarget = s.hp01 > 0 ? 1 : 0
    s.vis += (vTarget - s.vis) * a
    if (s.vis < 0.05 || !s.name) continue
    ctx.globalAlpha = s.vis
    const tx = s.x + (lastRadiusPx || 8) + pad, ty = s.y
    ctx.lineWidth = Math.max(2, Math.floor(3 * dpr))
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(s.name, tx, ty)
    ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.fillText(s.name, tx, ty)
  }
  ctx.globalAlpha = 1
  rafId = requestAnimationFrame(renderLabelsRAF)
}

function applyCountChange(n: number) {
  const N = Math.max(1, n | 0);
  ui.aliveCount = N;
  if (worker && boot.started) {
    worker.postMessage({ type: 'setCount', count: N });
    // labels & GPU avatars depend on indices range -> rebuild
    buildLabelIndices();
    sendGpuAvatarsList();
  }
}

// ---- GPU avatars list ----
function sendGpuAvatarsList() {
  if (!worker || !ui.gpuAvatars) return
  const entries: { index: number; url: string }[] = []
  for (const s of labelSlots) {
    const u = users.value.find(x => x.name === s.name)
    if (u?.avatarUrl) entries.push({ index: s.id, url: u.avatarUrl })
  }
  if (entries.length === 0 && users.value.length > 0 && users.value[0].avatarUrl) {
    entries.push({ index: 0, url: users.value[0].avatarUrl! })
  }
  worker.postMessage({ type: 'avatarsSet', tile: ui.avatarTilePx || 64, entries })
}

// ---- pause/resume/restart ----
function togglePause() {
  if (!worker) return
  ui.paused = !ui.paused
  worker.postMessage({ type: ui.paused ? 'pause' : 'resume' })
}
async function countdown(sec: number) {
  boot.counting = true
  for (let s = sec; s >= 0; s--) {
    boot.counter = s
    await new Promise(r => setTimeout(r, 1000))
  }
  boot.counting = false
}
async function startFight() {
  if (boot.started) return
  fit()
  await countdown(3)

  worker = new Worker(new URL('../workers/points.worker.ts', import.meta.url), { type: 'module' })

  worker.onmessage = (e: MessageEvent) => {
    const m = e.data as any
    if (m?.type === 'labels') {
      lastRadiusPx = m.radiusPx || lastRadiusPx
      lastAliveCount = typeof m.aliveCount === 'number' ? m.aliveCount : lastAliveCount
      drawLabelsFromWorker(m)
      return
    }
    if (m?.type === 'avatarsReady') {
      console.log('[GPU] avatarsReady:', m.tiles, 'tiles, atlas', m.atlasW, 'x', m.atlasH)
      return
    }
    if (m?.type === 'winner') {
      const idx = m.index | 0
      winner.value = { index: idx, name: nameForIndex(idx), avatarUrl: avatarForIndex(idx), hp: m.hp }
      return
    }
    if (m?.type === 'error') {
      console.error('Worker error:', m.error)
      return
    }
  }

  const c = pointsRef.value!
  const off = (c as any).transferControlToOffscreen() as OffscreenCanvas
  worker.postMessage({
    type: 'init',
    canvas: off,
    width: c.width,
    height: c.height,
    dpr,
    count: ui.aliveCount,
    maxFps: ui.fps
  }, [off])
  offscreenTransferred = true

  pushConfig()
  // ask worker to stream label positions
  buildLabelIndices()
  // send GPU avatars list
  sendGpuAvatarsList()

  boot.started = true
}
async function restartFight() {
  if (!boot.started) {
    await startFight()
    return
  }
  await countdown(3)
  winner.value = null
  ui.paused = false
  worker?.postMessage({ type: 'reset' })
}

// ---- winner helpers ----
type Winner = { index: number; name: string; avatarUrl?: string; hp: number }
const winner = ref<Winner | null>(null)
function nameForIndex(i: number): string {
  const n = users.value.length
  if (n === ui.aliveCount) return users.value[i]?.name ?? `Follower ${i + 1}`
  if (n > 0) return users.value[i % n]?.name ?? `Follower ${i + 1}`
  return `Follower ${i + 1}`
}
function avatarForIndex(i: number): string | undefined {
  const n = users.value.length
  if (n === ui.aliveCount) return users.value[i]?.avatarUrl
  if (n > 0) return users.value[i % n]?.avatarUrl
  return undefined
}

// ---- auto tune ----
const clampNum = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
function autoTuneNow() {
  const nUsers = users.value.length
  const N = Math.max(nUsers, ui.aliveCount)
  const L = (want: number) => clampNum(want, 0, nUsers)
  let preset: Partial<typeof ui> = {}
  if (N <= 1000) preset = { collisions: true, cellSizePx: 24, maxPairsPerCell: 512, labelsCount: L(200), labelsThrottleMs: 30, labelsSmoothMs: 120, radiusCss: 7, speedCss: 80, minSpeedCss: 20, maxSpeedCss: 200 }
  else if (N <= 10000) preset = { collisions: true, cellSizePx: 28, maxPairsPerCell: 256, labelsCount: L(128), labelsThrottleMs: 40, labelsSmoothMs: 140, radiusCss: 6, speedCss: 80, minSpeedCss: 20, maxSpeedCss: 180 }
  else if (N <= 50000) preset = { collisions: true, cellSizePx: 32, maxPairsPerCell: 128, labelsCount: L(96), labelsThrottleMs: 45, labelsSmoothMs: 150, radiusCss: 6, speedCss: 80, minSpeedCss: 20, maxSpeedCss: 160 }
  else if (N <= 100000) preset = { collisions: false, labelsCount: L(72), labelsThrottleMs: 50, labelsSmoothMs: 160, radiusCss: 6, speedCss: 80, minSpeedCss: 18, maxSpeedCss: 150 }
  else if (N <= 300000) preset = { collisions: false, labelsCount: L(56), labelsThrottleMs: 60, labelsSmoothMs: 170, radiusCss: 5, speedCss: 75, minSpeedCss: 16, maxSpeedCss: 140 }
  else preset = { collisions: false, labelsCount: L(32), labelsThrottleMs: 70, labelsSmoothMs: 180, radiusCss: 5, speedCss: 70, minSpeedCss: 14, maxSpeedCss: 130 }
  Object.assign(ui, preset)
  buildLabelIndices()
  pushConfig()
}

// ---- lifecycle ----
onMounted(() => {
  fit()
  if (stageRef.value) { ro = new ResizeObserver(() => fit()); ro.observe(stageRef.value) }
  window.addEventListener('resize', fit)

  parseUsersJSON()
  buildLabelIndices()

  lastRAF = performance.now()
  rafId = requestAnimationFrame(renderLabelsRAF)

  // watchers
  watch(() => [
    ui.radiusCss, ui.speedCss, ui.color, ui.bg,
    ui.ringColor, ui.ringWidthPx, ui.fps,
    ui.collisions, ui.cellSizePx, ui.maxPairsPerCell,
    ui.hpMax, ui.dmgHitMin, ui.dmgHitMax,
    ui.minSpeedCss, ui.maxSpeedCss, ui.hitBoostPct, ui.wallBoostPct,
    ui.autoRadius, ui.radiusScaleMax, ui.radiusScaleExp,
  ], pushConfig)

  watch(() => ui.dmgHitMin, v => { if (ui.dmgHitMax < v) ui.dmgHitMax = v })
  watch(() => ui.dmgHitMax, v => { if (v < ui.dmgHitMin) ui.dmgHitMin = v })
  watch(() => ui.minSpeedCss, v => { if (ui.maxSpeedCss < v) ui.maxSpeedCss = v })
  watch(() => ui.maxSpeedCss, v => { if (v < ui.minSpeedCss) ui.minSpeedCss = v })
  watch(usersJson, parseUsersJSON)
  watch(() => ui.aliveCount, v => applyCountChange(v));
  watch(users, () => { if (ui.autoTune) autoTuneNow(); buildLabelIndices(); }, { deep: true })
  watch(() => ui.labelsCount, buildLabelIndices)
  watch(() => [ui.gpuAvatars, ui.avatarTilePx], () => sendGpuAvatarsList())
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', fit)
  if (ro && stageRef.value) ro.unobserve(stageRef.value)
  if (rafId) cancelAnimationFrame(rafId)
  worker?.terminate(); worker = null
})
</script>

<template>
  <!-- Full-height layout with side panel -->
  <div class="gap-3 grid grid-cols-1 lg:grid-cols-[1fr_20rem] bg-slate-950 w-full h-screen">
    <!-- Stage -->
    <div ref="stageRef" class="relative rounded-xl ring-1 ring-slate-800 h-full overflow-hidden">
      <!-- WebGL / Offscreen target -->
      <canvas ref="pointsRef" class="block bg-transparent w-full h-full"></canvas>
      <!-- 2D overlay for labels (names only; avatars are on GPU) -->
      <canvas ref="labelsRef" class="z-10 absolute inset-0 pointer-events-none"></canvas>

      <!-- Start overlay -->
      <div v-if="!boot.started" class="z-20 absolute inset-0 flex justify-center items-center">
        <div class="absolute inset-0 bg-black/60"></div>
        <div class="z-10 relative flex flex-col items-center gap-4">
          <button
            v-show="!boot.counting"
            class="bg-emerald-600 hover:bg-emerald-500 shadow-lg px-6 py-3 rounded-xl font-semibold text-white text-lg"
            @click="startFight"
            :disabled="boot.counting"
          >
            Start
          </button>

          <div v-if="boot.counting" class="font-extrabold text-white text-center transition-all duration-300 ease-out">
            <div class="drop-shadow-xl tabular-nums text-7xl">{{ boot.counter }}</div>
            <div class="mt-1 text-slate-200 text-sm">Get ready</div>
          </div>
        </div>
      </div>

      <!-- In-run countdown (for Restart) -->
      <div v-if="boot.started && boot.counting" class="z-20 absolute inset-0 flex justify-center items-center">
        <div class="absolute inset-0 bg-black/40"></div>
        <div class="z-10 relative drop-shadow-xl font-extrabold tabular-nums text-white text-7xl">
          {{ boot.counter }}
        </div>
      </div>

      <!-- Winner modal -->
      <div v-if="winner" class="z-20 absolute inset-0 flex justify-center items-center">
        <div class="absolute inset-0 bg-black/60"></div>
        <div class="z-10 relative bg-slate-900/95 shadow-2xl p-6 border border-slate-700 rounded-2xl max-w-sm text-center">
          <div class="font-extrabold text-white text-3xl">Winner</div>

          <div v-if="winner.avatarUrl" class="mx-auto mt-4 rounded-full ring-4 ring-emerald-400/70 w-24 h-24 overflow-hidden">
            <img :src="winner.avatarUrl" crossorigin="anonymous" class="w-full h-full object-cover" />
          </div>

          <div class="mt-3 font-semibold text-slate-100 text-xl">{{ winner.name }}</div>
          <div class="mt-1 text-slate-400 text-sm">HP: {{ Math.round(winner.hp) }}</div>

          <div class="flex justify-center gap-2 mt-5">
            <button class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-lg font-medium text-white" @click="restartFight">
              Start new fight
            </button>
            <button class="bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg text-white" @click="winner = null">
              Close
            </button>
          </div>
        </div>
      </div>

      <!-- Mobile controls -->
      <div class="lg:hidden bottom-3 left-3 z-10 absolute flex gap-2">
        <button
          class="bg-sky-600 hover:bg-sky-500 shadow px-3 py-2 rounded-lg font-medium text-white text-sm"
          @click="togglePause"
          :disabled="!boot.started || boot.counting"
        >
          {{ ui.paused ? 'Resume' : 'Pause' }}
        </button>
        <button
          class="bg-rose-600 hover:bg-rose-500 shadow px-3 py-2 rounded-lg font-medium text-white text-sm"
          @click="restartFight"
          :disabled="boot.counting || !boot.started"
        >
          Restart
        </button>
      </div>
    </div>

    <!-- Side panel -->
    <aside class="hidden lg:block bg-slate-900/90 p-4 border border-slate-800 rounded-xl h-screen overflow-auto text-slate-200">
      <section class="mb-4">
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" v-model="ui.autoTune" class="accent-emerald-500" />
          <span class="text-sm">Авто-підлаштування</span>
        </label>
        <button class="bg-slate-700 hover:bg-slate-600 mt-2 px-2 py-1 rounded text-xs" @click="autoTuneNow">Re-tune now</button>
      </section>

      <!-- Users JSON -->
      <section>
        <h3 class="mb-2 font-semibold text-slate-100">Користувачі (JSON)</h3>
        <textarea
          v-model="usersJson"
          @change="parseUsersJSON"
          class="bg-slate-800 p-2 border border-slate-700 rounded-md w-full h-28 text-xs"
          spellcheck="false"
        ></textarea>
        <div class="flex justify-between items-center mt-1 text-slate-400 text-xs">
          <div>Знайдено: <span class="tabular-nums">{{ users.length }}</span></div>
          <button class="bg-slate-700 hover:bg-slate-600 px-2 py-1 rounded" @click="parseUsersJSON">Apply</button>
        </div>
      </section>

      <!-- Core settings -->
      <section class="mt-4">
        <h3 class="mb-2 font-semibold text-slate-100">Налаштування</h3>
        <LabeledNumber v-model.number="ui.aliveCount" label="Кількість кружечків" :min="10" :max="10000000" :step="1" />
        <LabeledRange v-model.number="ui.ringWidthPx" label="Товщина лінії ХР (px)" :min="1" :max="6" :step="1" />
        <LabeledRange v-model.number="ui.radiusCss" label="Радіус (px)" :min="2" :max="12" :step="1" />
        <LabeledRange v-model.number="ui.speedCss" label="Швидкість (px/s)" :min="10" :max="200" :step="1" />
        <LabeledRange v-model.number="ui.fps" label="FPS" :min="30" :max="120" :step="1" />
        <div class="gap-3 grid grid-cols-2 mt-3">
          <div>
            <div class="mb-1 text-slate-300 text-sm">Колір точок</div>
            <input type="color" v-model="ui.color" class="bg-slate-800 border border-slate-700 rounded-md w-full h-9" />
          </div>
          <div>
            <div class="mb-1 text-slate-300 text-sm">Фон</div>
            <input type="color" v-model="ui.bg" class="bg-slate-800 border border-slate-700 rounded-md w-full h-9" />
          </div>
        </div>
      </section>
      <!-- Labels / avatars -->
      <section class="mt-4 pt-4 border-slate-800 border-t">
        <h3 class="mb-2 font-semibold text-slate-100">Підписи</h3>
        <LabeledRange v-model.number="ui.labelsCount" label="Кількість підписів" :min="0" :max="256" :step="1" />
        <LabeledRange v-model.number="ui.labelsSmoothMs" label="Плавність підписів (мс)" :min="16" :max="600" :step="1" />
        <LabeledNumber v-model.number="ui.labelsThrottleMs" label="Оновлення позицій (мс)" :min="8" :max="200" :step="1" />
        <div class="gap-3 grid grid-cols-2 mt-3">
          <LabeledNumber v-model.number="ui.avatarTilePx" label="Розмір тайла аватара" :min="32" :max="128" :step="1" />
          <label class="inline-flex items-center gap-2">
            <input type="checkbox" v-model="ui.gpuAvatars" class="accent-emerald-500" />
            <span class="text-sm">GPU-аватарки (атлас)</span>
          </label>
        </div>
        <p class="mt-2 text-slate-400 text-xs">Аватарки рендеряться на GPU всередині кружків. Текст — на оверлеї.</p>
      </section>     

      <!-- Auto radius -->
      <section class="mt-4 pt-4 border-slate-800 border-t">
        <h3 class="mb-2 font-semibold text-slate-100">Авто-радіус</h3>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" v-model="ui.autoRadius" class="accent-emerald-500" />
          <span class="text-sm">Вмикати автоматичне збільшення радіуса</span>
        </label>
        <LabeledRange v-model.number="ui.radiusScaleMax" label="Max scale (×)" :min="1" :max="20" :step="0.1" />
        <LabeledRange v-model.number="ui.radiusScaleExp" label="Експонента (крива)" :min="0.1" :max="8" :step="0.1" />
      </section>

      <!-- Collisions -->
      <section class="mt-5 pt-4 border-slate-800 border-t">
        <h3 class="mb-2 font-semibold text-slate-100">Колізії</h3>
        <label class="inline-flex items-center gap-2">
          <input type="checkbox" v-model="ui.collisions" class="accent-emerald-500" />
          <span class="text-sm">Увімкнути колізії (апрокс.)</span>
        </label>
        <LabeledRange v-model.number="ui.cellSizePx" label="Розмір ґріда (px)" :min="8" :max="64" :step="1" />
        <LabeledRange v-model.number="ui.maxPairsPerCell" label="Ліміт пар/клітинку" :min="32" :max="512" :step="32" />
      </section>

      <!-- Speed & boosts -->
      <section class="mt-4 pt-4 border-slate-800 border-t">
        <h3 class="mb-2 font-semibold text-slate-100">Швидкість та буст</h3>
        <LabeledRange v-model.number="ui.minSpeedCss" label="Мін. швидкість (px/s)" :min="0" :max="300" :step="1" />
        <LabeledRange v-model.number="ui.maxSpeedCss" label="Макс. швидкість (px/s)" :min="ui.minSpeedCss" :max="800" :step="1" />
        <div class="gap-3 grid grid-cols-2 mt-3">
          <LabeledRange v-model.number="ui.hitBoostPct" label="Буст при зіткненні (%)" :min="0" :max="100" :step="1" />
          <LabeledRange v-model.number="ui.wallBoostPct" label="Буст від стіни (%)" :min="0" :max="100" :step="1" />
        </div>
      </section>

      <!-- Health -->
      <section class="mt-4 pt-4 border-slate-800 border-t">
        <h3 class="mb-2 font-semibold text-slate-100">Здоров'я (HP)</h3>
        <LabeledRange v-model.number="ui.hpMax" label="Max HP" :min="1" :max="2500" :step="1" />
        <div class="gap-3 grid grid-cols-2 mt-3">
          <LabeledRange v-model.number="ui.dmgHitMin" label="DMG min" :min="0" :max="50" :step="1" />
          <LabeledRange v-model.number="ui.dmgHitMax" label="DMG max" :min="ui.dmgHitMin" :max="50" :step="1" />
        </div>
        <button class="bg-rose-600 hover:bg-rose-500 shadow mt-3 px-3 py-2 rounded-lg font-medium text-white text-sm" @click="setAllHP">
          Set HP for all
        </button>
      </section>

      <!-- Actions -->
      <section class="flex gap-2 mt-5">
        <button
          class="bg-sky-600 hover:bg-sky-500 shadow px-3 py-2 rounded-lg font-medium text-white text-sm"
          @click="togglePause"
          :disabled="!boot.started || boot.counting"
        >
          {{ ui.paused ? 'Resume' : 'Pause' }}
        </button>
        <button
          class="bg-rose-600 hover:bg-rose-500 shadow px-3 py-2 rounded-lg font-medium text-white text-sm"
          @click="restartFight"
          :disabled="boot.counting || !boot.started"
        >
          Restart
        </button>
      </section>
    </aside>
  </div>
</template>

