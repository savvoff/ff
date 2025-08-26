/* eslint-disable @typescript-eslint/no-explicit-any */
// All comments in this code are in English only.

let canvas: OffscreenCanvas
let gl: WebGL2RenderingContext | null = null

let w = 1, h = 1, dpr = 1
let maxFps = 60
let paused = false
let lastTime = 0
let lastAlivePulse = 0
let winnerSent = false

// Simulation state
let count = 0
let px!: Float32Array
let py!: Float32Array
let vx!: Float32Array
let vy!: Float32Array
let hp!: Float32Array
let hp01!: Float32Array

// Config
const cfg = {
  radiusCss: 6,
  autoRadius: true,
  radiusScaleMax: 3.0,
  radiusScaleExp: 1.0,
  speedCss: 80,
  color: [0.953, 0.953, 1.0] as [number, number, number],
  bg: [0.043, 0.067, 0.102] as [number, number, number],
  ringColor: [0.345, 0.714, 1.0] as [number, number, number],
  ringWidthPx: 2,
  minSpeedCss: 20,
  maxSpeedCss: 200,
  hitBoostMul: 1.05,
  wallBoostMul: 1.10,
  // collisions
  collisions: true,
  cellSizePx: 24,
  maxPairsPerCell: 128,
  // HP/damage
  hpMax: 200,
  dmgHitMin: 6,
  dmgHitMax: 14,
}

function clamp(v: number, a: number, b: number) { return Math.min(b, Math.max(a, v)) }
function radiusDevice(): number {
  // Auto-scale by alive fraction
  const alive = aliveCount > 0 ? aliveCount : count
  const frac = 1 - alive / Math.max(1, count)
  if (!cfg.autoRadius) return cfg.radiusCss * dpr
  const k = Math.pow(frac, cfg.radiusScaleExp)
  const s = 1 + (cfg.radiusScaleMax - 1) * k
  return cfg.radiusCss * s * dpr
}

// Labels streaming
let labelIndices: Int32Array | null = null
let labelsThrottleMs = 50
let lastLabelsSent = 0

// GL objects for points
let prog: WebGLProgram
let vao: WebGLVertexArrayObject
let vboPos: WebGLBuffer
let vboHP: WebGLBuffer
let u_view: WebGLUniformLocation
let u_radiusPx: WebGLUniformLocation
let u_color: WebGLUniformLocation
let u_ringColor: WebGLUniformLocation
let u_ringWidthPx: WebGLUniformLocation

// ---------- GPU avatars state ----------
let progAvatar: WebGLProgram | null = null
let vaoAvatar: WebGLVertexArrayObject | null = null
let bufQuadAv: WebGLBuffer | null = null
let bufInstAv: WebGLBuffer | null = null
let atlasTex: WebGLTexture | null = null
let atlasW = 0, atlasH = 0
let avatarTile = 64
let avatarEntries: { index: number; url: string }[] = []
let avatarIndices: Int32Array | null = null
let avatarUVs: Float32Array | null = null
let avatarReady = false

// ---------- Collision grid state ----------
let gridW = 0, gridH = 0, cellPx = 24
let gridHead: Int32Array | null = null        // head index per cell
let gridPairsCount: Int32Array | null = null  // pairs used per cell (cap)
let nextInCell: Int32Array | null = null      // linked list: next index per particle

// Winner
let aliveCount = 0

// ---------- GL helpers ----------
function compile(type: number, src: string) {
  const s = gl!.createShader(type)!
  gl!.shaderSource(s, src); gl!.compileShader(s)
  if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
    const err = gl!.getShaderInfoLog(s)
    gl!.deleteShader(s)
    throw new Error(String(err))
  }
  return s
}
function link(vsSrc: string, fsSrc: string) {
  const vs = compile(gl!.VERTEX_SHADER, vsSrc)
  const fs = compile(gl!.FRAGMENT_SHADER, fsSrc)
  const p = gl!.createProgram()!
  gl!.attachShader(p, vs); gl!.attachShader(p, fs); gl!.linkProgram(p)
  if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
    const err = gl!.getProgramInfoLog(p)
    throw new Error(String(err))
  }
  gl!.deleteShader(vs); gl!.deleteShader(fs)
  return p
}

// ---------- Shaders ----------
const VS_POINTS = `#version 300 es
precision mediump float;
layout(location=0) in vec2 aPosPx;   // position in pixels
layout(location=1) in float aHP;     // 0..1
uniform vec2 u_view;                 // (w,h)
uniform float u_radiusPx;            // device px
out float vHP;
void main() {
  vec2 clip = (aPosPx / u_view * 2.0 - 1.0) * vec2(1.0, -1.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = u_radiusPx * 2.0;
  vHP = aHP;
}
`;

const FS_POINTS = `#version 300 es
precision mediump float;
in float vHP;
uniform vec3 u_color;
uniform vec3 u_ringColor;     // kept for slight tint + to stay active
uniform float u_ringWidthPx;
uniform float u_radiusPx;
out vec4 frag;

vec3 hpColor(float h) {
  // 0..1 -> red/orange/yellow/green thresholds
  if (h > 0.66) return vec3(0.23, 0.84, 0.36);  // green
  if (h > 0.33) return vec3(0.98, 0.87, 0.22);  // yellow
  if (h > 0.15) return vec3(0.98, 0.57, 0.20);  // orange
  return vec3(0.95, 0.27, 0.23);                // red
}

void main() {
  if (vHP <= 0.0) discard;

  // circle mask
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  float ring = clamp(u_ringWidthPx / max(u_radiusPx, 1.0), 0.0, 1.0);
  float inner = 1.0 - ring;

  vec3 col;
  if (r > inner) {
    // border uses HP color, softly tinted by uniform ring color
    vec3 hc = hpColor(clamp(vHP, 0.0, 1.0));
    col = mix(hc, u_ringColor, 0.15);
  } else {
    col = u_color;
  }

  float alpha = 0.9; // constant alpha; you can modulate by vHP if desired
  frag = vec4(col, alpha);
}
`;

// Avatar shaders
const VS_AVATAR = `#version 300 es
precision mediump float;
layout(location=0) in vec2 aPos;
layout(location=1) in vec2 iCenter;
layout(location=2) in float iRadius;
layout(location=3) in vec4 iUV;
uniform vec2 uResolution;
out vec2 vLocal;
out vec4 vUV;
out float vRadius;
void main() {
  vec2 posPx = iCenter + aPos * iRadius;
  vec2 clip = (posPx / uResolution * 2.0 - 1.0) * vec2(1.0, -1.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  vLocal = aPos;
  vUV = iUV;
  vRadius = iRadius;
}
`;

const FS_AVATAR = `#version 300 es
precision mediump float;
in vec2 vLocal;
in vec4 vUV;
in float vRadius;
uniform sampler2D uAtlas;
uniform float uRingPx;
out vec4 frag;
void main() {
  float r = length(vLocal);
  if (r > 1.0) discard;
  float inner = 1.0 - clamp(uRingPx / max(vRadius, 1.0), 0.0, 0.9);
  if (r > inner) discard;

  vec2 t = vLocal * 0.5 + 0.5;
  vec2 uv = mix(vUV.xy, vUV.zw, t);
  vec4 col = texture(uAtlas, uv);
  frag = vec4(col.rgb * col.a, col.a);
}
`;

// ---------- Init GL ----------
function initGL(cvs: OffscreenCanvas) {
  gl = cvs.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true }) as WebGL2RenderingContext
  if (!gl) throw new Error('WebGL2 not available')

  // Points program
  prog = link(VS_POINTS, FS_POINTS)
  vao = gl.createVertexArray()!
  vboPos = gl.createBuffer()!
  vboHP = gl.createBuffer()!

  gl.bindVertexArray(vao)

  // aPosPx at location 0 (vec2)
  gl.bindBuffer(gl.ARRAY_BUFFER, vboPos)
  gl.bufferData(gl.ARRAY_BUFFER, COUNT_BYTES_POS(), gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  // aHP at location 1 (float)
  gl.bindBuffer(gl.ARRAY_BUFFER, vboHP)
  gl.bufferData(gl.ARRAY_BUFFER, COUNT_BYTES_HP(), gl.DYNAMIC_DRAW)
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0)

  gl.bindVertexArray(null)

  u_view = gl.getUniformLocation(prog, 'u_view')!
  u_radiusPx = gl.getUniformLocation(prog, 'u_radiusPx')!
  u_color = gl.getUniformLocation(prog, 'u_color')!
  u_ringColor = gl.getUniformLocation(prog, 'u_ringColor')!
  u_ringWidthPx = gl.getUniformLocation(prog, 'u_ringWidthPx')!
}

function COUNT_BYTES_POS() { return count * 2 * 4 }
function COUNT_BYTES_HP() { return count * 4 }

// ---------- Avatars pipeline ----------
function initAvatarProgram() {
  if (!gl) return
  if (!progAvatar) progAvatar = link(VS_AVATAR, FS_AVATAR)
  if (!vaoAvatar) vaoAvatar = gl.createVertexArray()
  if (!bufQuadAv) bufQuadAv = gl.createBuffer()
  if (!bufInstAv) bufInstAv = gl.createBuffer()

  gl.bindVertexArray(vaoAvatar)

  // static quad
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  gl.bindBuffer(gl.ARRAY_BUFFER, bufQuadAv)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

  // per-instance: center(2), radius(1), uv(4) => 7 floats
  gl.bindBuffer(gl.ARRAY_BUFFER, bufInstAv)
  const stride = 7 * 4
  gl.enableVertexAttribArray(1)
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 0)
  gl.vertexAttribDivisor(1, 1)

  gl.enableVertexAttribArray(2)
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 2 * 4)
  gl.vertexAttribDivisor(2, 1)

  gl.enableVertexAttribArray(3)
  gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 3 * 4)
  gl.vertexAttribDivisor(3, 1)

  gl.bindVertexArray(null)
}

async function emptyBitmap(size: number) {
  const oc = new OffscreenCanvas(size, size)
  const cx = oc.getContext('2d')!
  cx.clearRect(0, 0, size, size)
  return await createImageBitmap(oc)
}

async function loadAvatarBitmap(
  url: string,
  tile: number,
): Promise<ImageBitmap> {
  try {
    const r = await fetch(url, {
      mode: 'cors',
      cache: 'force-cache',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const blob = await r.blob()
    const src = await createImageBitmap(blob)

    const w = src.width, h = src.height, side = Math.min(w, h)
    const sx = (w - side) * 0.5, sy = (h - side) * 0.5
    const bmp = await createImageBitmap(src, sx, sy, side, side, {
      resizeWidth: tile,
      resizeHeight: tile,
      resizeQuality: 'high'
    } as any)
    src.close()
    return bmp
  } catch {
    return emptyBitmap(tile)
  }
}

async function buildAvatarAtlas() {
  avatarReady = false
  if (!gl) return
  if (avatarEntries.length === 0) {
    avatarIndices = null; avatarUVs = null
    if (atlasTex) { gl.deleteTexture(atlasTex); atlasTex = null }
    ;(self as any).postMessage({ type: 'avatarsReady', tiles: 0, atlasW: 0, atlasH: 0 })
    return
  }

  const bitmaps: ImageBitmap[] = []
  for (const it of avatarEntries) {
    const bmp = await loadAvatarBitmap(it.url, avatarTile)
    bitmaps.push(bmp)
  }

  const K = bitmaps.length
  const cols = Math.ceil(Math.sqrt(K))
  const rows = Math.ceil(K / cols)
  atlasW = cols * avatarTile
  atlasH = rows * avatarTile

  if (!atlasTex) atlasTex = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, atlasTex!)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasW, atlasH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)

  avatarUVs = new Float32Array(K * 4)
  avatarIndices = new Int32Array(K)

  for (let i = 0; i < K; i++) {
    const bmp = bitmaps[i]
    const c = i % cols, r = (i / cols) | 0
    const x = c * avatarTile, y = r * avatarTile
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bmp)
    bmp.close()

    const u0 = x / atlasW, v0 = y / atlasH
    const u1 = (x + avatarTile) / atlasW, v1 = (y + avatarTile) / atlasH
    avatarUVs.set([u0, v0, u1, v1], i * 4)
    avatarIndices[i] = avatarEntries[i].index | 0
  }
  gl.generateMipmap(gl.TEXTURE_2D)
  gl.bindTexture(gl.TEXTURE_2D, null)

  initAvatarProgram()
  avatarReady = true
  ;(self as any).postMessage({ type: 'avatarsReady', tiles: K, atlasW, atlasH })
}

function renderAvatarsPass() {
  if (!avatarReady || !progAvatar || !vaoAvatar || !bufInstAv || !atlasTex || !avatarIndices || !avatarUVs) return
  const K = avatarIndices.length
  if (K === 0) return

  const R = radiusDevice()
  const inst = new Float32Array(K * 7)
  let n = 0
  for (let i = 0; i < K; i++) {
    const id = avatarIndices[i] | 0
    if (id < 0 || id >= hp01.length || hp01[id] <= 0) continue
    const off = n * 7, uvo = i * 4
    inst[off + 0] = px[id]; inst[off + 1] = py[id]; inst[off + 2] = R
    inst[off + 3] = avatarUVs[uvo + 0]; inst[off + 4] = avatarUVs[uvo + 1]
    inst[off + 5] = avatarUVs[uvo + 2]; inst[off + 6] = avatarUVs[uvo + 3]
    n++
  }
  if (n === 0) return

  gl!.useProgram(progAvatar!)
  gl!.bindVertexArray(vaoAvatar!)
  gl!.bindBuffer(gl!.ARRAY_BUFFER, bufInstAv!)
  gl!.bufferData(gl!.ARRAY_BUFFER, inst.subarray(0, n * 7), gl!.DYNAMIC_DRAW)

  const uRes = gl!.getUniformLocation(progAvatar!, 'uResolution')!
  const uRing = gl!.getUniformLocation(progAvatar!, 'uRingPx')!
  const uAtl = gl!.getUniformLocation(progAvatar!, 'uAtlas')!
  gl!.uniform2f(uRes, w, h)
  gl!.uniform1f(uRing, Math.max(1, cfg.ringWidthPx * dpr))
  gl!.activeTexture(gl!.TEXTURE0)
  gl!.bindTexture(gl!.TEXTURE_2D, atlasTex!)
  gl!.uniform1i(uAtl, 0)

  gl!.enable(gl!.BLEND)
  gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA)
  gl!.drawArraysInstanced(gl!.TRIANGLE_STRIP, 0, 4, n)
  gl!.bindVertexArray(null)
  gl!.useProgram(null)
}

// ---------- Collision grid helpers ----------
function ensureGrid(currentRadius: number) {
  // Dynamic cell: at least particle diameter to guarantee neighbor coverage
  const wantCell = Math.max(8, Math.ceil(Math.max(cfg.cellSizePx * dpr, 2 * currentRadius)));
  if (wantCell !== cellPx) cellPx = wantCell;

  const gw = Math.max(1, Math.ceil(w / cellPx));
  const gh = Math.max(1, Math.ceil(h / cellPx));
  if (gw !== gridW || gh !== gridH || !gridHead || !gridPairsCount) {
    gridW = gw; gridH = gh;
    gridHead = new Int32Array(gridW * gridH);
    gridPairsCount = new Int32Array(gridW * gridH);
  }
  if (!nextInCell || nextInCell.length !== count) nextInCell = new Int32Array(count);
  gridHead.fill(-1);
  gridPairsCount.fill(0);
}

function cellIndexFor(x: number, y: number) {
  let cx = Math.floor(x / cellPx);
  let cy = Math.floor(y / cellPx);
  if (cx < 0) cx = 0; else if (cx >= gridW) cx = gridW - 1;
  if (cy < 0) cy = 0; else if (cy >= gridH) cy = gridH - 1;
  return cy * gridW + cx;
}

function buildGrid(currentRadius: number) {
  ensureGrid(currentRadius);
  const head = gridHead!, next = nextInCell!;
  for (let i = 0; i < count; i++) {
    if (hp[i] <= 0) { next[i] = -1; continue; }
    // Clamp to arena to avoid out-of-range cells
    const x = clamp(px[i], currentRadius, w - currentRadius);
    const y = clamp(py[i], currentRadius, h - currentRadius);
    const cell = cellIndexFor(x, y);
    next[i] = head[cell];
    head[cell] = i;
  }
}

// ---------- Simulation ----------
function initSim(n: number) {
  count = n
  px = new Float32Array(n)
  py = new Float32Array(n)
  vx = new Float32Array(n)
  vy = new Float32Array(n)
  hp = new Float32Array(n)
  hp01 = new Float32Array(n)

  for (let i = 0; i < n; i++) {
    px[i] = Math.random() * w
    py[i] = Math.random() * h
    const ang = Math.random() * Math.PI * 2
    const sp = cfg.speedCss * dpr * (0.5 + Math.random()) * 0.5
    vx[i] = Math.cos(ang) * sp
    vy[i] = Math.sin(ang) * sp
    hp[i] = cfg.hpMax
    hp01[i] = 1
  }
  aliveCount = n
  winnerSent = false
}

function clampSpeed(i: number) {
  const minS = cfg.minSpeedCss * dpr
  const maxS = cfg.maxSpeedCss * dpr
  const sx = vx[i], sy = vy[i]
  const s = Math.hypot(sx, sy)
  if (s < minS) {
    if (s > 1e-4) { vx[i] = (sx / s) * minS; vy[i] = (sy / s) * minS }
    else {
      const a = Math.random() * Math.PI * 2
      vx[i] = Math.cos(a) * minS
      vy[i] = Math.sin(a) * minS
    }
  } else if (s > maxS) {
    vx[i] = (sx / s) * maxS; vy[i] = (sy / s) * maxS
  }
}

function step(dt: number) {
  const r = radiusDevice()
  const maxX = w - r, maxY = h - r

  // Integrate + walls
  for (let i = 0; i < count; i++) {
    if (hp[i] <= 0) continue
    let x = px[i] + vx[i] * dt
    let y = py[i] + vy[i] * dt

    if (x < r) { x = r; vx[i] = -vx[i]; vx[i] *= cfg.wallBoostMul; vy[i] *= cfg.wallBoostMul; }
    else if (x > maxX) { x = maxX; vx[i] = -vx[i]; vx[i] *= cfg.wallBoostMul; vy[i] *= cfg.wallBoostMul; }
    if (y < r) { y = r; vy[i] = -vy[i]; vx[i] *= cfg.wallBoostMul; vy[i] *= cfg.wallBoostMul; }
    else if (y > maxY) { y = maxY; vy[i] = -vy[i]; vx[i] *= cfg.wallBoostMul; vy[i] *= cfg.wallBoostMul; }

    // light damping to keep things sane
    vx[i] *= 0.999; vy[i] *= 0.999

    px[i] = x; py[i] = y
    clampSpeed(i)
  }

  if (cfg.collisions) {
    // If radius just grew a lot, do two narrow-phase passes to resolve overlaps faster
    const iterations =  (radiusDevice() > (step as any)._lastR * 1.1) ? 2 : 1;
    (step as any)._lastR = radiusDevice();

    for (let pass = 0; pass < iterations; pass++) {
      const rNow = radiusDevice();
      buildGrid(rNow);

      const head = gridHead!, next = nextInCell!, pairsCap = Math.max(1, cfg.maxPairsPerCell);
      const e = 1.0; // elasticity
      const rx = Math.ceil((2 * rNow) / cellPx);
      const ry = Math.ceil((2 * rNow) / cellPx);

      for (let cy = 0; cy < gridH; cy++) {
        for (let cx = 0; cx < gridW; cx++) {
          const baseCell = cy * gridW + cx;
          let pairsUsed = 0;

          for (let oy = 0; oy <= ry; oy++) {
            for (let ox = -rx; ox <= rx; ox++) {
              // avoid double work: for oy==0, only ox>=0; for ox==0, handle j>i below
              if (oy === 0 && ox < 0) continue;

              const nxCell = cx + ox, nyCell = cy + oy;
              if (nxCell < 0 || nxCell >= gridW || nyCell < 0 || nyCell >= gridH) continue;
              const otherCell = nyCell * gridW + nxCell;

              for (let i = head[baseCell]; i !== -1; i = next[i]) {
                if (hp[i] <= 0) continue;

                for (let j = head[otherCell]; j !== -1; j = next[j]) {
                  if (hp[j] <= 0) continue;
                  if (otherCell === baseCell && j <= i) continue; // avoid duplicates
                  if (pairsUsed >= pairsCap) break;
                  pairsUsed++;

                  // circle-circle
                  const dx = px[j] - px[i];
                  const dy = py[j] - py[i];
                  const rsum = rNow + rNow;
                  const dist2 = dx * dx + dy * dy;
                  if (dist2 > rsum * rsum) continue;

                  const dist = Math.sqrt(dist2) || 1e-6;
                  const nx = dx / dist, ny = dy / dist;
                  const overlap = rsum - dist;

                  // positional split correction
                  const corr = overlap * 0.5;
                  px[i] -= nx * corr; py[i] -= ny * corr;
                  px[j] += nx * corr; py[j] += ny * corr;

                  // relative normal velocity
                  const rvx = vx[j] - vx[i], rvy = vy[j] - vy[i];
                  const vn = rvx * nx + rvy * ny;
                  if (vn < 0) {
                    const jimp = -(1 + e) * vn * 0.5;
                    vx[i] -= jimp * nx; vy[i] -= jimp * ny;
                    vx[j] += jimp * nx; vy[j] += jimp * ny;
                  }

                  // boost & clamp
                  vx[i] *= cfg.hitBoostMul; vy[i] *= cfg.hitBoostMul;
                  vx[j] *= cfg.hitBoostMul; vy[j] *= cfg.hitBoostMul;
                  clampSpeed(i); clampSpeed(j);

                  // damage
                  const dmin = Math.min(cfg.dmgHitMin, cfg.dmgHitMax);
                  const dmax = Math.max(cfg.dmgHitMin, cfg.dmgHitMax);
                  const dmg = dmin + Math.random() * (dmax - dmin);
                  hp[i] -= dmg; hp[j] -= dmg;
                }
              }
            }
          }
          gridPairsCount![baseCell] = pairsUsed;
        }
      }
    }
  } else {
    // Fallback: cheap random nearby damage (kept for non-collision mode)
    for (let k = 0; k < Math.min(32, count >> 2); k++) {
      const i = (Math.random() * count) | 0
      const j = (Math.random() * count) | 0
      if (i === j) continue
      if (hp[i] <= 0 || hp[j] <= 0) continue
      const dx = px[j] - px[i], dy = py[j] - py[i]
      const rr = (r + r)
      if (dx * dx + dy * dy < rr * rr) {
        const dmin = Math.min(cfg.dmgHitMin, cfg.dmgHitMax)
        const dmax = Math.max(cfg.dmgHitMin, cfg.dmgHitMax)
        const dmg = dmin + Math.random() * (dmax - dmin)
        hp[i] -= dmg; hp[j] -= dmg
        vx[i] *= cfg.hitBoostMul; vy[i] *= cfg.hitBoostMul
        vx[j] *= cfg.hitBoostMul; vy[j] *= cfg.hitBoostMul
        clampSpeed(i); clampSpeed(j)
      }
    }
  }

  // hp01 & alive count
  const maxHP = cfg.hpMax || 1
  let alive = 0, lastIdx = -1
  for (let i = 0; i < count; i++) {
    const v = maxHP > 0 ? hp[i] / maxHP : 0
    const nv = v <= 0 ? 0 : (v >= 1 ? 1 : v)
    hp01[i] = nv
    if (nv > 0) { alive++; lastIdx = i }
  }
  aliveCount = alive

  // winner event
  if (aliveCount === 1 && !winnerSent && lastIdx !== -1) {
    ;(self as any).postMessage({ type: 'winner', index: lastIdx, hp: hp[lastIdx], x: px[lastIdx], y: py[lastIdx], radiusPx: r })
    winnerSent = true
  } else if (aliveCount > 1) {
    winnerSent = false
  }
}

// ---------- Render ----------
let tmpInterleave: Float32Array | null = null
function interleaveXY(x: Float32Array, y: Float32Array) {
  const n = x.length
  const need = n * 2
  if (!tmpInterleave || tmpInterleave.length < need) tmpInterleave = new Float32Array(need)
  for (let i = 0; i < n; i++) { const o = i * 2; tmpInterleave[o] = x[i]; tmpInterleave[o + 1] = y[i] }
  return tmpInterleave
}

function render() {
  if (!gl) return
  gl.viewport(0, 0, w, h)
  gl.clearColor(cfg.bg[0], cfg.bg[1], cfg.bg[2], 1.0)
  gl.clear(gl.COLOR_BUFFER_BIT)

  // upload position and hp01
  gl.bindBuffer(gl.ARRAY_BUFFER, vboPos)
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, interleaveXY(px, py))
  gl.bindBuffer(gl.ARRAY_BUFFER, vboHP)
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, hp01)

  gl.useProgram(prog)
  gl.bindVertexArray(vao)

  const radPx = radiusDevice()
  gl.uniform2f(u_view, w, h)
  gl.uniform1f(u_radiusPx, radPx)
  gl.uniform3f(u_color, cfg.color[0], cfg.color[1], cfg.color[2])
  gl.uniform3f(u_ringColor, cfg.ringColor[0], cfg.ringColor[1], cfg.ringColor[2])
  gl.uniform1f(u_ringWidthPx, Math.max(2, Math.floor(cfg.ringWidthPx * dpr)))

  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.drawArrays(gl.POINTS, 0, count)
  gl.bindVertexArray(null)
  gl.useProgram(null)

  // avatars on top
  renderAvatarsPass()
}

// ---------- Labels stream ----------
function sendLabels() {
  if (!labelIndices || labelIndices.length === 0) return
  const K = labelIndices.length
  const out = new Float32Array(K * 3)
  for (let i = 0; i < K; i++) {
    const idx = labelIndices[i] | 0
    out[i * 3 + 0] = px[idx]
    out[i * 3 + 1] = py[idx]
    out[i * 3 + 2] = hp01[idx]
  }
  ;(self as any).postMessage({ type: 'labels', data: out.buffer, radiusPx: radiusDevice(), aliveCount }, [out.buffer])
}

// ---------- Loop ----------
function loop() {
  if (paused) { setTimeout(loop, 16); return }
  const now = performance.now()
  const dt = Math.min(0.05, (now - (lastTime || now)) / 1000)
  lastTime = now

  step(dt)
  render()

  if (performance.now() - lastAlivePulse >= 300) {
    (self as any).postMessage({ type: 'alive', aliveCount })
    lastAlivePulse = performance.now()
  }
  
  if (now - lastLabelsSent >= labelsThrottleMs) { sendLabels(); lastLabelsSent = now }

  const target = 1000 / Math.max(1, maxFps)
  const delay = Math.max(0, target - (performance.now() - now))
  setTimeout(loop, delay | 0)
}

// ---------- Messages ----------
self.onmessage = async (e: MessageEvent) => {
  const m: any = e.data
  try {
    if (m.type === 'init') {
      canvas = m.canvas as OffscreenCanvas
      w = m.width | 0; h = m.height | 0; dpr = m.dpr || 1
      count = m.count | 0
      maxFps = m.maxFps || 60
      initGL(canvas)
      initSim(count)
      lastTime = performance.now()
      paused = false
      loop()
      return
    }
    if (m.type === 'resize') {
      w = m.width | 0; h = m.height | 0; dpr = m.dpr || dpr
      return
    }
    if (m.type === 'fps') { maxFps = m.maxFps || maxFps; return }
    if (m.type === 'pause') { paused = true; return }
    if (m.type === 'resume') { paused = false; lastTime = performance.now(); return }
    if (m.type === 'reset') {
      initSim(count)
      lastTime = performance.now()
      paused = false
      winnerSent = false
      return
    }
    if (m.type === 'config') {
      for (const k of Object.keys(m)) if (k in cfg && k !== 'type') (cfg as any)[k] = m[k]
      return
    }
    if (m.type === 'hpSetAll') {
      const v = (typeof m.hp === 'number') ? Math.max(0, m.hp) : cfg.hpMax
      for (let i = 0; i < count; i++) { hp[i] = v; hp01[i] = v <= 0 ? 0 : 1 }
      aliveCount = v > 0 ? count : 0
      winnerSent = false
      return
    }
    if (m.type === 'labelsConfig') {
      const arr = m.indices as number[]
      labelIndices = new Int32Array(arr || [])
      labelsThrottleMs = m.throttleMs || 50
      if (m.sendOnce) sendLabels()
      return
    }
    if (m.type === 'avatarsSet') {
      avatarTile = Math.max(16, (m.tile | 0) || 64)
      avatarEntries = Array.isArray(m.entries) ? m.entries : []
      await buildAvatarAtlas()
      ;(self as any).postMessage({ type: 'avatarsReady', tiles: avatarEntries.length, atlasW, atlasH })
      return
    }
  } catch (err: any) {
    ;(self as any).postMessage({ type: 'error', error: String(err?.message || err) })
  }
}
