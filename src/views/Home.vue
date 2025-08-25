<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import LabeledNumber from '@/components/LabeledNumber.vue';
import LabeledRange from '@/components/LabeledRange.vue';
import Scoreboard from '@/components/Scoreboard.vue';
import { useLocalStorage } from '@/composables/useLocalStorage';

// ---------- Types ----------
interface Follower { name: string; avatarUrl?: string }
interface Particle {
  id: number; name: string; color: string;
  x: number; y: number; vx: number; vy: number; r: number; baseR?: number;
  hp: number; maxHp: number; alive: boolean; avatar?: HTMLImageElement;
  // death animation
  dying?: boolean; deathLeft?: number; // seconds
  renderAlpha?: number; renderScale?: number;
}

// ---------- State ----------
const isStylesReady = inject('TAILWIND') as Ref<boolean | undefined>
const followers = shallowRef<Follower[]>([])
const seed = ref(42)
const arena = reactive({ width: 0, height: 0 })
const defaultParams = {
  maxFollowers: 200,
  radiusMin: 10,
  radiusMax: 12,
  baseHp: 400,
  damageMin: 6,
  damageMax: 14,
  elasticity: 0.8,
  speed: 1.4,
  endless: false,
  // motion & effects
  minSpeed: 300,      // px/s minimal speed
  maxSpeed: 450,      // px/s cap
  jitter: 10,         // px/s^2 random accel
  accelOnHit: 1.18,   // × speed boost on collisions
  accelOnWall: 1.1,   // × speed boost on wall bounce
  deathFadeMs: 600,   // fade+shrink duration
  deathShrink: 0.1,
  // growth when fewer players remain
  growthEnabled: true,
  growthMaxScale: 4.5,
  growthExponent: 1,
  // growth params:
  growthStartSurvivors: 0.4,   // Growth starts when living ≤ 50% of the initial
  growthFullSurvivors: 0.05,   // full growth at ≤ 12.5%
  growthSmoothSec: 0.9,        // seconds up to ~63% rapprochement
}

// Load from localStorage (if exists), else use defaults
const saved = useLocalStorage('params', defaultParams)
const params = saved.value ?? reactive(defaultParams)
const running = ref(true)
const winner = ref<Particle|null>(null)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const particles = shallowRef<Particle[]>([])
let anim = 0
let initialAlive = 0
let rng = () => Math.random()

// DPR scaling
const dpr = computed(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1))

// ---------- Helpers ----------
function mulberry32(s: number) {
  let t = s >>> 0
  return function() {
    t += 0x6D2B79F5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}
const clamp = (v:number, min:number, max:number) => Math.max(min, Math.min(max, v))
const lerp = (a:number,b:number,t:number) => a + (b-a)*t
function initials(name?: string) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0,2)
  return parts.map(p => p[0]?.toUpperCase() || '?').join('')
}
function smoothstep(e0:number,e1:number,x:number){
  const t = clamp((x - e0) / Math.max(1e-6, (e1 - e0)), 0, 1)
  return t*t*(3 - 2*t) // плавні краї
}

// ---------- Followers ingest ----------
function parseTextFollowers(text: string): Follower[] {
  try {
    const arr = JSON.parse(text)
    if (Array.isArray(arr)) return arr.filter(x => x && typeof x.name === 'string').map(x => ({ name: String(x.name), avatarUrl: x.avatarUrl }))
  } catch {}
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(name => ({ name }))
}
function ingestFollowers(text: string) { followers.value = parseTextFollowers(text) }
function onTextareaInput(e: Event) {
  const t = e.target as HTMLTextAreaElement
  ingestFollowers(t.value)
}
async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  followers.value = parseTextFollowers(text)
  input.value = ''
}
function useDemo() {
  followers.value = Array.from({ length: 80 }, (_, i) => ({ name: `Follower ${i+1}` }))
}

// ---------- Build particles ----------
async function buildParticles() {
  rng = mulberry32(seed.value)
    const src: Record<any, string>[] = (followers.value && followers.value.length ? followers.value : Array.from({ length: 100000 }, (_, i) => ({ name: `Follower ${i+1}` })))
    .slice(0, Math.min(params.maxFollowers))

  const loaded: Particle[] = []
  for (let idx = 0; idx < src.length; idx++) {
    const f = src[idx]
    const p: Particle = {
      id: idx,
      name: f.name,
      color: `hsl(${Math.floor(rng()*360)},70%,60%)`,
      x: rng() * arena.width,
      y: rng() * arena.height,
      vx: (rng()*2 - 1) * 80 * params.speed,
      vy: (rng()*2 - 1) * 80 * params.speed,
      r: lerp(params.radiusMin, params.radiusMax, rng()),
      baseR: undefined,
      hp: params.baseHp,
      maxHp: params.baseHp,
      alive: true,
      renderAlpha: 1,
      renderScale: 1,
    }
    if (f.avatarUrl) {
      try {
        const img = new Image()
        img.crossOrigin = 'anonymous'
        await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = f.avatarUrl! })
        p.avatar = img
      } catch {}
    }
    loaded.push(p)
  }
  for (const p of loaded) { p.baseR = p.baseR ?? p.r }
  particles.value = loaded
  initialAlive = loaded.length
  winner.value = null
  running.value = true
}

// ---------- Spatial grid ----------
function buildGrid(ps: Particle[], cellSize: number) {
  const grid = new Map<string, number[]>()
  for (let i=0;i<ps.length;i++) {
    const p = ps[i]; if (!p.alive && !p.dying) continue
    const cx = Math.floor(p.x / cellSize)
    const cy = Math.floor(p.y / cellSize)
    const key = `${cx},${cy}`
    let bucket = grid.get(key)
    if (!bucket) { bucket = []; grid.set(key, bucket) }
    bucket.push(i)
  }
  return { grid, cellSize }
}
function *neighbors(i:number, ps: Particle[], gridData: {grid: Map<string, number[]>, cellSize: number}) {
  const { grid, cellSize } = gridData
  const p = ps[i]
  const cx = Math.floor(p.x / cellSize)
  const cy = Math.floor(p.y / cellSize)
  for (let gx = cx-1; gx <= cx+1; gx++) {
    for (let gy = cy-1; gy <= cy+1; gy++) {
      const key = `${gx},${gy}`
      const bucket = grid.get(key)
      if (!bucket) continue
      for (const j of bucket) if (j > i) yield j
    }
  }
}

// ---------- Physics / Growth ----------
// function computeGrowthScale(aliveCount: number) {
//   if (!params.growthEnabled) return 1
//   const N0 = Math.max(1, initialAlive)
//   const N = clamp(aliveCount, 1, N0)
//   const t = (N0 > 1) ? (N0 - N) / (N0 - 1) : 1 // 0 at start, 1 when one left
//   const curved = Math.pow(t, params.growthExponent)
//   return 1 + (params.growthMaxScale - 1) * curved
// }
function getEffR(p: Particle, gScale: number) {
  const base = (p.baseR ?? p.r)
  const scale = p.dying ? ((p.renderScale ?? 1) * gScale) : gScale
  return base * scale
}
function targetGrowthScale(aliveCount: number) {
  const N0 = Math.max(1, initialAlive)
  const aliveFrac = aliveCount / N0                 // 1..0
  const startDead = 1 - params.growthStartSurvivors // 0..1
  const fullDead  = 1 - params.growthFullSurvivors  // 0..1
  const deadFrac  = 1 - aliveFrac
  let t = smoothstep(startDead, fullDead, deadFrac) // 0..1
  t = Math.pow(t, params.growthExponent)            // The shape of the curve
  return 1 + (params.growthMaxScale - 1) * t
}
let gScaleCurrent = 1
function updateGrowth(dt:number){
  if (!params.growthEnabled) return 1
  const alive = particles.value.reduce((s,p)=>s + (p.alive && !p.dying ? 1 : 0), 0)
  const gTarget = targetGrowthScale(alive)
  const tau = Math.max(0.001, params.growthSmoothSec)
  const alpha = 1 - Math.pow(0.0001, dt / tau)      // Exponential step
  gScaleCurrent = lerp(gScaleCurrent, gTarget, alpha)
  return gScaleCurrent
}

// ---------- Physics ----------
function enforceMinSpeed(p: Particle) {
  const v = Math.hypot(p.vx, p.vy)
  const minV = Math.max(0, params.minSpeed)
  const maxV = Math.max(minV, params.maxSpeed || (minV + 1))

  if (v < minV) {
    if (v < 1e-3) {
      const ang = rng() * Math.PI * 2
      p.vx = Math.cos(ang) * minV
      p.vy = Math.sin(ang) * minV
    } else {
      const k = minV / v
      p.vx *= k; p.vy *= k
    }
  } else if (v > maxV) {
    const k = maxV / v
    p.vx *= k; p.vy *= k
  }
}

function step(dt: number, ctx: CanvasRenderingContext2D) {
  const ps = particles.value
  const W = arena.width, H = arena.height

  // growth factor based on alive count
  const aliveCountForGrowth = ps.reduce((acc, p) => acc + (p.alive && !p.dying ? 1 : 0), 0)
  const gScale = updateGrowth(aliveCountForGrowth)

  // integrate, walls, jitter, death timers
  for (const p of ps) {
    if (!p.alive && !p.dying) continue

    // update death anim
    if (p.dying) {
      p.deathLeft = (p.deathLeft ?? 0) - dt
      const t = clamp((p.deathLeft ?? 0) / (params.deathFadeMs/1000), 0, 1)
      p.renderAlpha = t
      p.renderScale = lerp(params.deathShrink, 1, t)
      if ((p.deathLeft ?? 0) <= 0) { p.dying = false; p.alive = false; }
    }

    p.x += p.vx * dt
    p.y += p.vy * dt

    // walls with effective radius
    const effR = getEffR(p, gScale)
    if (p.x - effR < 0) { p.x = effR; p.vx = -p.vx * params.elasticity; p.vx *= params.accelOnWall; p.vy *= params.accelOnWall }
    if (p.x + effR > W) { p.x = W - effR; p.vx = -p.vx * params.elasticity; p.vx *= params.accelOnWall; p.vy *= params.accelOnWall }
    if (p.y - effR < 0) { p.y = effR; p.vy = -p.vy * params.elasticity; p.vx *= params.accelOnWall; p.vy *= params.accelOnWall }
    if (p.y + effR > H) { p.y = H - effR; p.vy = -p.vy * params.elasticity; p.vx *= params.accelOnWall; p.vy *= params.accelOnWall }

    // mild damping then jitter
    p.vx *= 0.999; p.vy *= 0.999
    const jx = (rng()*2 - 1) * params.jitter
    const jy = (rng()*2 - 1) * params.jitter
    p.vx += jx * dt
    p.vy += jy * dt

    enforceMinSpeed(p)
  }

  // collisions via grid
  // choose grid cell size based on CURRENT effective radii so big balls collide at edges
  let maxEffR = 0
  for (const p of ps) if (p.alive && !p.dying) {
    const r = getEffR(p, gScale)
    if (r > maxEffR) maxEffR = r
  }
  const cell = Math.max(16, Math.ceil(2 * maxEffR))
  const gridData = buildGrid(ps, cell)
  for (let i=0;i<ps.length;i++) {
    const a = ps[i]; if (!(a.alive && !a.dying)) continue
    for (const j of neighbors(i, ps, gridData)) {
      const b = ps[j]; if (!(b.alive && !b.dying)) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const aR = getEffR(a, gScale), bR = getEffR(b, gScale)
      const rsum = aR + bR
      const dist2 = dx*dx + dy*dy
      if (dist2 <= rsum*rsum) {
        const dist = Math.sqrt(dist2) || 0.0001
        const overlap = rsum - dist
        const nx = dx / dist, ny = dy / dist
        const corr = overlap / 2
        a.x -= nx * corr; a.y -= ny * corr
        b.x += nx * corr; b.y += ny * corr

        const rvx = b.vx - a.vx, rvy = b.vy - a.vy
        const vn = rvx*nx + rvy*ny
        if (vn < 0) {
          const e = params.elasticity
          const imp = -(1+e)*vn
          a.vx -= imp*nx*0.5; a.vy -= imp*ny*0.5
          b.vx += imp*nx*0.5; b.vy += imp*ny*0.5
        }

        // speed boost on hit
        a.vx *= params.accelOnHit; a.vy *= params.accelOnHit
        b.vx *= params.accelOnHit; b.vy *= params.accelOnHit

        const dmin = Math.min(params.damageMin, params.damageMax)
        const dmax = Math.max(params.damageMin, params.damageMax)
        const dmg = dmin + rng() * (dmax - dmin)
        a.hp -= dmg
        b.hp -= dmg

        // death handling
        if (a.hp <= 0 && (a.alive || a.dying === undefined || !a.dying)) {
          if (params.endless) {
            // instant respawn
            a.x = rng() * arena.width; a.y = rng() * arena.height
            a.vx = (rng()*2 - 1) * 80 * params.speed; a.vy = (rng()*2 - 1) * 80 * params.speed
            a.hp = a.maxHp; a.dying = false; a.renderAlpha = 1; a.renderScale = 1
          } else {
            a.dying = true; a.deathLeft = params.deathFadeMs/1000; a.renderAlpha = 1; a.renderScale = 1
          }
        }
        if (b.hp <= 0 && (b.alive || b.dying === undefined || !b.dying)) {
          if (params.endless) {
            b.x = rng() * arena.width; b.y = rng() * arena.height
            b.vx = (rng()*2 - 1) * 80 * params.speed; b.vy = (rng()*2 - 1) * 80 * params.speed
            b.hp = b.maxHp; b.dying = false; b.renderAlpha = 1; b.renderScale = 1
          } else {
            b.dying = true; b.deathLeft = params.deathFadeMs/1000; b.renderAlpha = 1; b.renderScale = 1
          }
        }

        enforceMinSpeed(a); enforceMinSpeed(b)
      }
    }
  }

  // winner check (non-endless)
  if (!params.endless) {
    const aliveCount = ps.reduce((acc, p) => acc + (p.alive && !p.dying ? 1 : 0), 0)
    if (aliveCount === 1) {
      const champ = ps.find(p => p.alive && !p.dying) || null
      if (champ) {
        winner.value = champ
        // snap champion to center and stop sim
        champ.x = arena.width/2; champ.y = arena.height/3
        champ.vx = 0; champ.vy = 0
        setTimeout(() => running.value = false, params.deathFadeMs + 100);
      }
    }
  }

  draw(ctx)
}

// ---------- Render ----------
function resize(cvs: HTMLCanvasElement | null) {
  if (!cvs) return
  const rectW = cvs.clientWidth || 1280
  arena.width = arena.width || rectW
  arena.height = arena.height || Math.round(rectW * 9/16)

  cvs.width  = Math.floor(arena.width  * dpr.value)
  cvs.height = Math.floor(arena.height * dpr.value)
  cvs.style.width  = arena.width + 'px'
  cvs.style.height = arena.height + 'px'

  const ctx = cvs.getContext('2d')
  if (ctx) {
    ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0)
  }
}

function draw(ctx: CanvasRenderingContext2D) {
  const W = arena.width, H = arena.height
  ctx.clearRect(0,0,W,H)

  // background grid
  ctx.save()
  ctx.globalAlpha = 0.6
  ctx.fillStyle = '#0B1020'
  ctx.fillRect(0,0,W,H)
  ctx.globalAlpha = 0.25; ctx.strokeStyle = '#2A3350'; ctx.lineWidth = 1
  for (let x=0;x<W;x+=40){ ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke() }
  for (let y=0;y<H;y+=40){ ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke() }
  ctx.restore()

  

  // growth factor for rendering
  const aliveForGrowth = particles.value.reduce((acc, p) => acc + (p.alive && !p.dying ? 1 : 0), 0)
  const gScale = updateGrowth(aliveForGrowth)

  for (const p of particles.value) {
    if (!p.alive && !p.dying) continue

    const hpT = clamp(p.hp / p.maxHp, 0, 1)
    let scale = (p.renderScale ?? 1) * gScale
    const alpha = p.renderAlpha ?? 1

    ctx.save();
    ctx.globalAlpha = alpha
    ctx.translate(p.x, p.y)
    ctx.scale(scale, scale)
    ctx.shadowColor = p.color; ctx.shadowBlur = 10

    // body
    const grad = ctx.createRadialGradient(0,0,p.r*0.2, 0,0,p.r)
    grad.addColorStop(0, '#fff'); grad.addColorStop(1, p.color)
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(0,0,p.r,0,Math.PI*2); ctx.fill()

    // hp ring
    ctx.lineWidth = 3
    ctx.strokeStyle = `hsl(${hpT*120}, 80%, 50%)`
    ctx.beginPath(); ctx.arc(0,0,p.r+3,-Math.PI/2,-Math.PI/2 + Math.PI*2*hpT); ctx.stroke()

    // avatar / initials
    if (p.avatar) {
      const s = p.r * 1.6
      ctx.save(); ctx.beginPath(); ctx.arc(0,0,p.r*0.9,0,Math.PI*2); ctx.clip()
      ctx.drawImage(p.avatar, -s/2, -s/2, s, s)
      ctx.restore()
    } else {
      ctx.fillStyle = '#0b1020'
      ctx.font = `${Math.floor(p.r)}px ui-sans-serif, system-ui`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(initials(p.name), 0, 0)
    }
    ctx.restore()

    // name label (no fade)
    ctx.save()
    ctx.fillStyle = '#e5e7eb'
    ctx.font = `10px ui-sans-serif, system-ui`
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    const baseR = (p.baseR ?? p.r) * gScale
    ctx.fillText(p.name, p.x, p.y + baseR + 6)
    ctx.restore()
  }
}

// ---------- Game loop ----------
onMounted(async () => {
  const cvs = canvasRef.value
  if (!cvs) return
  
  const ctx = cvs.getContext('2d')!
  ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0)

  let last = performance.now()
  const loop = (t: number) => {
    anim = requestAnimationFrame(loop)
    if (!running.value) return
    const now = t
    let dt = (now - last) / 1000
    dt = clamp(dt, 0, 0.033) // ~30 FPS step
    last = now
    step(dt, ctx)
  }
  anim = requestAnimationFrame(loop)

  draw(ctx)

  const stopResizeWatch = watch(
    () => [arena.width, arena.height, dpr.value],
    () => resize(cvs)
  );

  const onWinResize = () => resize(canvasRef.value)
  window.addEventListener('resize', onWinResize)

  onBeforeUnmount(() => {
    cancelAnimationFrame(anim)
    stopResizeWatch()
    window.removeEventListener('resize', onWinResize)
  })
});


watch(() => isStylesReady.value, (value) => {
  if (value) {
    resize(canvasRef.value)
  }
})


// ---------- Controls ----------
async function onStart() { 
  await buildParticles(); 
  seed.value = Math.floor(Math.random() * 100);
  running.value = true; 
}
async function onReset() { running.value = false; await buildParticles() }
</script>


<template>
  <div class="bg-[#0b1020] min-h-screen text-slate-200">
    <div class="mx-auto p-4 md:p-6">
      <header class="flex justify-between items-center gap-4 mb-4">
        <h1 class="font-bold text-2xl md:text-3xl tracking-tight">Followers Fight</h1>
        <div class="flex items-center gap-2">
          <button @click="onStart" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-2xl active:scale-[0.98]">Start New Fight</button>
          <button @click="onReset" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-2xl">Reset</button>
        </div>
      </header>

      <div class="gap-4 grid grid-cols-1 lg:grid-cols-3">
        <!-- Left: Controls -->
        <section class="space-y-4 lg:col-span-1">
          <div class="bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="mb-3 font-semibold">Followers</h2>
            <div class="space-y-3">
              <textarea
                class="bg-slate-900/70 p-3 border border-slate-700/50 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 w-full h-28 text-sm"
                placeholder="Paste JSON array or newline names..."
                @input="onTextareaInput"
              />
              <div class="flex items-center gap-2">
                <label class="inline-flex items-center bg-slate-700/70 hover:bg-slate-600/70 px-3 py-2 rounded-xl cursor-pointer">
                  <input type="file" accept=".json,.txt,.csv" class="hidden" @change="onFile" />
                  Upload file
                </label>
                <button class="bg-slate-700/70 hover:bg-slate-600/70 px-3 py-2 rounded-xl" @click="useDemo()">Use demo</button>
              </div>
              <p class="text-slate-400 text-xs">Format: <code>[{ name: "Alice", avatarUrl: "https://..." }]</code> or one name per line.</p>
            </div>
          </div>
          <div class="space-y-3 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="font-semibold">Arena</h2> 
            <div class="gap-3 grid grid-cols-2 text-sm">
              <labeled-number label="Width" v-model.number="arena.width" :min="320" :max="1920" />
              <labeled-number label="Height" v-model.number="arena.height" :min="240" :max="1080" />
            </div>
          </div>
          <div class="space-y-3 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="font-semibold">Parameters</h2>
            <div class="gap-3 grid grid-cols-2 text-sm">
              <labeled-number label="Max followers" v-model.number="params.maxFollowers" :min="1" :max="2000" />
              <labeled-number label="Seed" v-model.number="seed" :min="0" :max="999999" />
              <labeled-number label="Radius min" v-model.number="params.radiusMin" :min="4" :max="60" />
              <labeled-number label="Radius max" v-model.number="params.radiusMax" :min="6" :max="80" />
              <labeled-number label="HP" v-model.number="params.baseHp" :min="10" :max="500" />
              <labeled-number label="Damage hit min" v-model.number="params.damageMin" :min="0" :max="100" />
              <labeled-number label="Damage hit max" v-model.number="params.damageMax" :min="0" :max="200" />
              <labeled-range label="Elasticity" v-model.number="params.elasticity" :min="0" :max="1" :step="0.01" />
              <labeled-range label="Base speed" v-model.number="params.speed" :min="0.2" :max="3" :step="0.05" />
              <labeled-number label="Min speed (px/s)" v-model.number="params.minSpeed" :min="0" :max="300" />
              <labeled-number label="Max speed (px/s)" v-model.number="params.maxSpeed" :min="10" :max="2000" />
              <labeled-number label="Accel on hit (×)" v-model.number="params.accelOnHit" :min="1" :max="3" :step="0.05" />
              <labeled-number label="Accel on wall (×)" v-model.number="params.accelOnWall" :min="1" :max="3" :step="0.05" />
              <labeled-number label="Jitter (px/s²)" v-model.number="params.jitter" :min="0" :max="200" />
              <labeled-number label="Death fade (ms)" v-model.number="params.deathFadeMs" :min="50" :max="4000" :step="50" />
              <labeled-range label="Death shrink" v-model.number="params.deathShrink" :min="0" :max="1" :step="0.05" />
              <label class="flex items-center gap-2 col-span-2 text-sm">
                <input type="checkbox" v-model="params.growthEnabled" class="accent-emerald-500">
                <span>Grow as players die</span>
              </label>
              <labeled-number label="Growth max scale" v-model.number="params.growthMaxScale" :min="1" :max="10" :step="0.05" />
              <labeled-number label="Growth exponent" v-model.number="params.growthExponent" :min="0.25" :max="3" :step="0.05" />
              <labeled-number label="Growth starts when survivors (%)" v-model.number="params.growthStartSurvivors" :min="0" :max="1" :step="0.05" />
              <labeled-number label="Full survivors growth at (%)" v-model.number="params.growthFullSurvivors" :min="0" :max="1" :step="0.05" />
              <labeled-number label="Growth Smooth (sec)" v-model.number="params.growthSmoothSec" :min="0" :max="1" :step="0.1" />
              <label class="flex items-center gap-2 col-span-2 text-sm">
                <input type="checkbox" v-model="params.endless" class="accent-emerald-500">
                <span>Endless mode (instant respawn instead of death)</span>
              </label>
            </div>
          </div>          
        </section>

        <!-- Right: Canvas + scoreboard -->
        <section class="space-y-4 lg:col-span-2">
          <div class="border border-slate-700/50 rounded-2xl overflow-hidden">
            <div class="relative">
              <canvas ref="canvasRef" class="block bg-[#0b1020] w-full h-auto" />
              <div v-if="winner" class="absolute inset-0 flex justify-center items-center bg-black/50">
                <div class="bg-white/10 backdrop-blur-sm p-6 border border-white/20 rounded-2xl text-center">
                  <div class="font-black text-4xl tracking-tight">🏆 {{ winner?.name }}</div>
                  <div class="opacity-80 mt-1">last one standing</div>
                </div>
              </div>
            </div>
          </div>

          <scoreboard :particles="particles" />
        </section>
      </div>
    </div>
  </div>
</template>