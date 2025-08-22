<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, reactive, computed, nextTick } from 'vue'
import LabeledNumber from '@/components/LabeledNumber.vue';
import LabeledRange from '@/components/LabeledRange.vue';

// Add WebGPU types if missing (for TypeScript)
type GPUCanvasContext = any;
type GPUTextureFormat = any;
type GPUDevice = any;
const canvasRef = ref<HTMLCanvasElement|null>(null)
const running = ref(false)
const seed = ref(42)
const cfg = reactive({
  count: 200000,
  speed: 1.4,
  minSpeed: 300,
  maxSpeed: 450,
  elasticity: 0.8,
  accelOnHit: 1.18,
  accelOnWall: 1.10,
  jitter: 10,
  radiusMin: 6,
  radiusMax: 12,
  baseHp: 400,
  damageMin: 6,
  damageMax: 14,
  deathFadeMs: 600,
  deathShrink: 0.1,
  growthEnabled: true,
  growthMaxScale: 4.5,
  growthExponent: 1.0,
  growthStartSurvivors: 0.4,
  growthFullSurvivors: 0.05,
  growthSmoothSec: 0.9,
  enableCollisions: true,
  endless: false,
})

const statsText = computed(()=> running.value ? `Running • N=${cfg.count.toLocaleString()}` : 'Paused')
const winnerIdx = ref(-1)

let device: GPUDevice
let context: GPUCanvasContext
let format: GPUTextureFormat
let pipelines: any = {}
let bindGroups: any = {}
let buffers: any = {}
let animation = 0
let last = 0
let frameId = 0

// Canvas helper to avoid null ref usage
function getCanvas(): HTMLCanvasElement {
  const c = canvasRef.value as HTMLCanvasElement | null
  if (!c) { throw new Error('Canvas not mounted yet') }
  return c
}

// ========= WGSL SHADERS =========
// Storage particle layout
const wgslCommon = /* wgsl */`
struct Particle {
  pos: vec2<f32>,
  vel: vec2<f32>,
  r: f32,
  hp: f32,
  maxHp: f32,
  alive: u32,
  dying: u32,
  deathLeft: f32,
  color: vec3<f32>,
  _pad: f32,
};

struct SimParams {
  dt: f32; W: f32; H: f32; speed: f32;
  minSpeed: f32; maxSpeed: f32; elasticity: f32; accelOnWall: f32;
  jitter: f32; gScale: f32; cellSize: f32; damageMin: f32;
  damageMax: f32; accelOnHit: f32; deathFadeSec: f32; time: f32;
  gridW: u32; gridH: u32; endless: u32; _padU: u32;
};

struct Counters { alive: atomic<u32>, lastAlive: atomic<u32> };

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> U: SimParams;
@group(0) @binding(2) var<storage, read_write> cellHead: array<i32>;
@group(0) @binding(3) var<storage, read_write> nextPtr: array<i32>;
@group(0) @binding(4) var<storage, read_write> counters: Counters;

fn hash(u: u32) -> f32 {
  var x = u * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return f32(x) / 4294967295.0;
}

fn clampf(x:f32, a:f32, b:f32) -> f32 { return max(a, min(b, x)); }
`;

const csClearGrid = /* wgsl */`${wgslCommon}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = i32(gid.x);
  let total = i32(U.gridW) * i32(U.gridH);
  if (idx < total) { cellHead[idx] = -1; }
}
`;

const csIntegrate = /* wgsl */`${wgslCommon}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&particles)) { return; }
  var p = particles[i];
  if (p.alive == 0u && p.dying == 0u) { return; }

  // death anim
  if (p.dying == 1u) {
    p.deathLeft -= U.dt;
    if (p.deathLeft <= 0.0) {
      p.dying = 0u; p.alive = 0u;
    }
  }

  // integrate
  p.pos += p.vel * (U.dt * U.speed);

  // walls
  let effR = p.r * U.gScale * (select(1.0, clampf(p.deathLeft / U.deathFadeSec, 0.0, 1.0)*(1.0-U.deathFadeSec)+U.deathFadeSec, p.dying==1u));
  var r = max(1.0, effR);
  if (p.pos.x < r) { p.pos.x = r; p.vel.x = -p.vel.x * U.elasticity; p.vel *= vec2<f32>(U.accelOnWall, U.accelOnWall); }
  if (p.pos.x > U.W - r) { p.pos.x = U.W - r; p.vel.x = -p.vel.x * U.elasticity; p.vel *= vec2<f32>(U.accelOnWall, U.accelOnWall); }
  if (p.pos.y < r) { p.pos.y = r; p.vel.y = -p.vel.y * U.elasticity; p.vel *= vec2<f32>(U.accelOnWall, U.accelOnWall); }
  if (p.pos.y > U.H - r) { p.pos.y = U.H - r; p.vel.y = -p.vel.y * U.elasticity; p.vel *= vec2<f32>(U.accelOnWall, U.accelOnWall); }

  // damping + jitter
  p.vel *= 0.999;
  let fr = u32(floor(U.time*60.0));
  let jx = (hash(i ^ (fr*1664525u)) * 2.0 - 1.0) * U.jitter;
  let jy = (hash((i+12345u) ^ (fr*1013904223u)) * 2.0 - 1.0) * U.jitter;
  p.vel += vec2<f32>(jx, jy) * U.dt;

  // speed bounds
  let v = length(p.vel);
  if (v < U.minSpeed) {
    if (v < 1e-3) {
      let ang = hash(i ^ (fr*747796405u)) * 6.28318;
      p.vel = vec2<f32>(cos(ang), sin(ang)) * U.minSpeed;
    } else {
      p.vel *= U.minSpeed / v;
    }
  } else if (v > U.maxSpeed) {
    p.vel *= U.maxSpeed / v;
  }

  // alive counter (for CPU to fetch)
  if (p.alive == 1u && p.dying == 0u) {
    atomicAdd(&counters.alive, 1u);
    atomicStore(&counters.lastAlive, i);
  }

  particles[i] = p;
}
`;

const csBuildGrid = /* wgsl */`${wgslCommon}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  if (u32(i) >= arrayLength(&particles)) { return; }
  let p = particles[u32(i)];
  if (p.alive == 0u || p.dying == 1u) { nextPtr[i] = -1; return; }
  let cs = U.cellSize;
  let gx = clamp(i32(p.pos.x / cs), 0, i32(U.gridW)-1);
  let gy = clamp(i32(p.pos.y / cs), 0, i32(U.gridH)-1);
  let idx = gy * i32(U.gridW) + gx;
  // push front (lock-free): next[i] = atomicExchange(head[idx], i)
  nextPtr[i] = atomicExchange(&cellHead[idx], i);
}
`;

const csCollide = /* wgsl */`${wgslCommon}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = i32(gid.x);
  if (u32(i) >= arrayLength(&particles)) { return; }
  var self = particles[u32(i)];
  if (self.alive == 0u) { return; }

  // Skip resolving if dying: just fade out
  let gW = i32(U.gridW); let gH = i32(U.gridH); let cs = U.cellSize;
  let cx = clamp(i32(self.pos.x / cs), 0, gW-1);
  let cy = clamp(i32(self.pos.y / cs), 0, gH-1);

  // Effective radius
  let dyingScale = select(1.0, clampf(self.deathLeft / U.deathFadeSec, 0.0, 1.0) * (1.0-U.deathFadeSec) + U.deathFadeSec, self.dying==1u);
  let aR = self.r * U.gScale * dyingScale;

  for (var gy = cy-1; gy <= cy+1; gy++) {
    if (gy < 0 || gy >= gH) { continue; }
    for (var gx = cx-1; gx <= cx+1; gx++) {
      if (gx < 0 || gx >= gW) { continue; }
      var j = cellHead[gy * gW + gx];
      loop {
        if (j < 0) { break; }
        if (j != i) {
          let other = particles[u32(j)];
          if (other.alive == 1u && other.dying == 0u) {
            let dx = other.pos.x - self.pos.x;
            let dy = other.pos.y - self.pos.y;
            let rsum = aR + other.r * U.gScale;
            let d2 = dx*dx + dy*dy;
            if (d2 <= rsum*rsum) {
              let d = sqrt(max(d2, 1e-6));
              let nx = dx / d; let ny = dy / d;
              let overlap = rsum - d;
              // Move ONLY self (no races)
              let corr = overlap * 0.8; // a bit more to reduce sinking
              self.pos.x -= nx * corr; self.pos.y -= ny * corr;
              // Elastic reflect of self against other
              let rvx = other.vel.x - self.vel.x;
              let rvy = other.vel.y - self.vel.y;
              let vn = rvx*nx + rvy*ny;
              if (vn < 0.0) {
                let imp = -(1.0 + U.elasticity) * vn;
                self.vel.x -= imp * nx; self.vel.y -= imp * ny;
                self.vel *= vec2<f32>(U.accelOnHit, U.accelOnHit);
              }
              // Damage to self (symmetric)
              let fr = u32(floor(U.time*60.0));
              let rnd = hash(u32(i) ^ (fr * 69069u));
              let dmg = mix(U.damageMin, U.damageMax, rnd);
              if (self.hp > 0.0) { self.hp -= dmg; }
              if (self.hp <= 0.0 && self.dying == 0u) {
                if (U.endless == 1u) {
                  // respawn random
                  let rx = hash(u32(i) ^ 1234567u) * U.W;
                  let ry = hash(u32(i) ^ 7654321u) * U.H;
                  self.pos = vec2<f32>(rx, ry);
                  self.vel = vec2<f32>( (rnd*2.0-1.0)*80.0*U.speed, ((1.0-rnd)*2.0-1.0)*80.0*U.speed );
                  self.hp = self.maxHp; self.dying = 0u; self.alive = 1u; self.deathLeft = 0.0;
                } else {
                  self.dying = 1u; self.deathLeft = U.deathFadeSec;
                }
              }
            }
          }
        }
        j = nextPtr[j];
      }
    }
  }

  // enforce speed bounds again after collisions
  let v = length(self.vel);
  if (v < U.minSpeed) { self.vel *= U.minSpeed / max(v, 1e-6); }
  if (v > U.maxSpeed) { self.vel *= U.maxSpeed / v; }

  particles[u32(i)] = self;
}
`;

const vsQuad = /* wgsl */`${wgslCommon}
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) color: vec3<f32>, @location(2) alpha: f32 };
@vertex
fn main(@builtin(instance_index) inst: u32, @builtin(vertex_index) vid: u32) -> VSOut {
  let p = particles[inst];
  var scale = U.gScale;
  if (p.dying == 1u) {
    let t = clampf(p.deathLeft / U.deathFadeSec, 0.0, 1.0);
    scale *= mix(U.deathShrink, 1.0, t);
  }
  let r = max(1.0, p.r * scale);

  var corner = vec2<f32>(0.0, 0.0);
  if (vid == 0u) { corner = vec2<f32>(-r, -r); }
  if (vid == 1u) { corner = vec2<f32>( r, -r); }
  if (vid == 2u) { corner = vec2<f32>(-r,  r); }
  if (vid == 3u) { corner = vec2<f32>( r,  r); }
  let xy = (p.pos + corner);
  let ndc = vec2<f32>( (xy.x / U.W) * 2.0 - 1.0, 1.0 - (xy.y / U.H) * 2.0 );
  var o: VSOut;
  o.pos = vec4<f32>(ndc, 0.0, 1.0);
  o.uv = corner / (r*2.0) + 0.5; // 0..1
  var a = 1.0;
  if (p.dying == 1u) { a = clampf(p.deathLeft / U.deathFadeSec, 0.0, 1.0); }
  o.color = p.color; o.alpha = a;
  return o;
}
`;

const fsCircle = /* wgsl */`
@fragment
fn main(@location(0) uv: vec2<f32>, @location(1) color: vec3<f32>, @location(2) a: f32) -> @location(0) vec4<f32> {
  let d = distance(uv, vec2<f32>(0.5,0.5));
  if (d > 0.5) { discard; }
  let shade = 0.7 + (0.3 * (1.0 - d*2.0));
  return vec4<f32>(color * shade, a);
}
`;

// ========= JS/TS SIDE =========
function assert(ok: any, msg='assert'){ if(!ok) throw new Error(msg) }

const dpr = () => Math.max(1, window.devicePixelRatio || 1)
let gridW = 1, gridH = 1, cellSize = 16

// Define GPUBufferUsage globally for reuse
const GPUBufferUsage = (navigator as any).gpu?.GPUBufferUsage || {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
};

async function init() {
  assert('gpu' in navigator, 'WebGPU not available')
  const adapter = await (navigator as any).gpu.requestAdapter()
  assert(adapter, 'No GPU adapter')
  device = await adapter.requestDevice()

  const canvas = getCanvas()
  context = canvas.getContext('webgpu') as GPUCanvasContext
  format = (navigator as any).gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })

  resize()
  createPipelines()
  allocBuffers()
  build()
}

function resize() {
  const canvas = getCanvas()
  const W = (canvas.clientWidth || 1280), H = Math.round(W * 9/16)
  canvas.width = Math.floor(W * dpr())
  canvas.height = Math.floor(H * dpr())
}

function allocBuffers() {
  const N = cfg.count
  const particleStride = 4*2 + 4*2 + 4 + 4 + 4 + 4 + 4 + 4 + 4*3 + 4 // 4B per scalar
  const bytes = particleStride * N
  const GPUBufferUsage = (navigator as any).gpu?.GPUBufferUsage || {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
  buffers.particles = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })

  // next pointers for cell linked lists
  buffers.nextPtr = device.createBuffer({ size: N*4, usage: GPUBufferUsage.STORAGE })

  // grid heads (will be resized in build())
  const W = getCanvas().width, H = getCanvas().height
  cellSize = Math.max(8, Math.ceil(2 * cfg.radiusMax * 1.2))
  gridW = Math.max(1, Math.ceil(W / cellSize))
  gridH = Math.max(1, Math.ceil(H / cellSize))
  buffers.cellHead = device.createBuffer({ size: gridW*gridH*4, usage: GPUBufferUsage.STORAGE })

  // uniforms
  buffers.uniforms = device.createBuffer({ size: 4*4*5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }) // 20 floats

  // counters (alive, lastAlive)
  buffers.counters = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  buffers.countersRead = device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
}

function createPipelines() {
  pipelines.clearGrid = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: csClearGrid }), entryPoint: 'main' } })
  pipelines.integrate = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: csIntegrate }), entryPoint: 'main' } })
  pipelines.buildGrid = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: csBuildGrid }), entryPoint: 'main' } })
  pipelines.collide = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: csCollide }), entryPoint: 'main' } })
  pipelines.render = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: device.createShaderModule({ code: vsQuad }), entryPoint: 'main' },
    fragment: { module: device.createShaderModule({ code: fsCircle }), entryPoint: 'main', targets: [{ format, blend: { color: {srcFactor:'src-alpha', dstFactor:'one-minus-src-alpha', operation:'add'}, alpha:{srcFactor:'one', dstFactor:'one-minus-src-alpha', operation:'add'} } }] },
    primitive: { topology: 'triangle-strip' },
  })
}

function build() {
  // init particle data on CPU
  const N = cfg.count
  const f32 = new Float32Array((4*2 + 4*2 + 1 + 1 + 1 + 1 + 1 + 1 + 3 + 1) * N) // same stride/4
  const u32 = new Uint32Array(f32.buffer)
  const R = (min:number,max:number)=>min + (max-min)*mulberry32(seed.value)()
  const rand = mulberry32(seed.value)
  const W = getCanvas().width, H = getCanvas().height
  for (let i=0;i<N;i++) {
    let off = i* ( (f32.length)/N )
    let x = rand()*W, y = rand()*H
    let r = R(cfg.radiusMin, cfg.radiusMax)
    let vx = (rand()*2-1) * 80 * cfg.speed
    let vy = (rand()*2-1) * 80 * cfg.speed
    f32[off+0] = x; f32[off+1] = y; // pos
    f32[off+2] = vx; f32[off+3] = vy; // vel
    f32[off+4] = r; // r
    f32[off+5] = cfg.baseHp; // hp
    f32[off+6] = cfg.baseHp; // maxHp
    u32[off+7] = 1; // alive
    u32[off+8] = 0; // dying
    f32[off+9] = 0; // deathLeft
    // color
    const hue = rand()*6.28318
    f32[off+10] = 0.6 + 0.4*Math.cos(hue)
    f32[off+11] = 0.6 + 0.4*Math.cos(hue+2.094)
    f32[off+12] = 0.6 + 0.4*Math.cos(hue+4.188)
    f32[off+13] = 0 // pad
  }
  device.queue.writeBuffer(buffers.particles, 0, f32.buffer)

  // reset counters
  const zero = new Uint32Array([0, 4294967295])
  device.queue.writeBuffer(buffers.counters, 0, zero)

  // bind groups (after buffers exist)
  bindGroups.sim = device.createBindGroup({ layout: pipelines.integrate.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: buffers.particles } },
    { binding: 1, resource: { buffer: buffers.uniforms } },
    { binding: 2, resource: { buffer: buffers.cellHead } },
    { binding: 3, resource: { buffer: buffers.nextPtr } },
    { binding: 4, resource: { buffer: buffers.counters } },
  ]})
  bindGroups.render = bindGroups.sim // same layout
}

function writeUniforms(dt:number, gScale:number, time:number) {
  // Pack in 20 floats (must match WGSL struct order)
  const u = new ArrayBuffer(4*4*5)
  const f = new Float32Array(u)
  const ui = new Uint32Array(u)
  const W = getCanvas().width, H = getCanvas().height
  f[0]=dt; f[1]=W; f[2]=H; f[3]=cfg.speed;
  f[4]=cfg.minSpeed; f[5]=cfg.maxSpeed; f[6]=cfg.elasticity; f[7]=cfg.accelOnWall;
  f[8]=cfg.jitter; f[9]=gScale; f[10]=cellSize; f[11]=cfg.damageMin;
  f[12]=cfg.damageMax; f[13]=cfg.accelOnHit; f[14]=cfg.deathFadeMs/1000; f[15]=time;
  f[16]=gridW; f[17]=gridH; ui[18]=cfg.endless?1:0; ui[19]=0;
  device.queue.writeBuffer(buffers.uniforms, 0, u)
}

function computeGScale(alive:number, N0:number, dt:number){
  if (!cfg.growthEnabled) return 1
  const aliveFrac = alive / Math.max(1,N0)
  const startDead = 1 - cfg.growthStartSurvivors
  const fullDead  = 1 - cfg.growthFullSurvivors
  const deadFrac  = 1 - aliveFrac
  const t0 = Math.min(1, Math.max(0, (deadFrac - startDead) / Math.max(1e-6, (fullDead-startDead))))
  const t = t0*t0*(3-2*t0)
  const curved = Math.pow(t, cfg.growthExponent)
  const target = 1 + (cfg.growthMaxScale - 1) * curved
  // exponential smoothing
  const tau = Math.max(0.001, cfg.growthSmoothSec)
  gScaleCurrent = gScaleCurrent + (target - gScaleCurrent) * (1 - Math.pow(0.0001, dt / tau))
  return gScaleCurrent
}

let N0 = 0
let gScaleCurrent = 1
let lastAliveCPU = 0
let timeSec = 0
let readbackDivider = 8

function frame(t: number) {
  animation = requestAnimationFrame(frame)
  if (!running.value) return
  const dt = Math.min(0.033, last ? (t - last)/1000 : 0.016); last = t; timeSec += dt; frameId++

  // Resize-derived grid (recreate grid if needed)
  const W = getCanvas().width, H = getCanvas().height
  const desired = Math.max(8, Math.ceil(2 * cfg.radiusMax * gScaleCurrent))
  if (Math.abs(desired - cellSize) > 2) {
    cellSize = desired; gridW = Math.max(1, Math.ceil(W / cellSize)); gridH = Math.max(1, Math.ceil(H / cellSize))
    buffers.cellHead.destroy?.(); buffers.cellHead = device.createBuffer({ size: gridW*gridH*4, usage: GPUBufferUsage.STORAGE })
    build() // rebind
  }

  // Reset counters to 0 each frame before integrate
  {
    const zero = new Uint32Array([0, 4294967295])
    device.queue.writeBuffer(buffers.counters, 0, zero)
  }

  // uniforms (use previous gScaleCurrent; updated after readback)
  writeUniforms(dt, gScaleCurrent, timeSec)

  const encoder = device.createCommandEncoder()

  // compute: integrate (also counts alive)
  {
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipelines.integrate)
    pass.setBindGroup(0, bindGroups.sim)
    pass.dispatchWorkgroups(Math.ceil(cfg.count / 256))
    pass.end()
  }

  if (cfg.enableCollisions) {
    // clear grid
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipelines.clearGrid)
      pass.setBindGroup(0, bindGroups.sim)
      pass.dispatchWorkgroups(Math.ceil((gridW*gridH) / 256))
      pass.end()
    }
    // build grid
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipelines.buildGrid)
      pass.setBindGroup(0, bindGroups.sim)
      pass.dispatchWorkgroups(Math.ceil(cfg.count / 256))
      pass.end()
    }
    // collide (approx; self-only updates to avoid races)
    {
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipelines.collide)
      pass.setBindGroup(0, bindGroups.sim)
      pass.dispatchWorkgroups(Math.ceil(cfg.count / 256))
      pass.end()
    }
  }

  // render
  const rpass = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0.043, g: 0.063, b: 0.125, a: 1 }, storeOp: 'store' }]
  })
  rpass.setPipeline(pipelines.render)
  rpass.setBindGroup(0, bindGroups.render)
  rpass.draw(4, cfg.count)
  rpass.end()

  // read alive once in a while
  if ((frameId % readbackDivider) === 0) {
    encoder.copyBufferToBuffer(buffers.counters, 0, buffers.countersRead, 0, 8)
  }

  device.queue.submit([encoder.finish()])

  // map readback if we scheduled it
  if ((frameId % readbackDivider) === 0) {
    const GPUMapMode = (navigator as any).gpu?.GPUMapMode || { READ: 0x0001, WRITE: 0x0002 };
    buffers.countersRead.mapAsync(GPUMapMode.READ).then(()=>{
      const arr = new Uint32Array(buffers.countersRead.getMappedRange())
      const alive = arr[0]; const lastAlive = arr[1]
      buffers.countersRead.unmap()
      lastAliveCPU = alive
      winnerIdx.value = (alive === 1 && !cfg.endless) ? lastAlive : -1
      gScaleCurrent = computeGScale(alive, N0, dt)
    }).catch(()=>{})
  } else {
    // keep smoothing with last known alive
    gScaleCurrent = computeGScale(lastAliveCPU, N0, dt)
  }
}

async function start() {
  await nextTick()
  if (!device) { await init() }
  resize(); allocBuffers(); build();
  N0 = cfg.count; lastAliveCPU = N0; gScaleCurrent = 1; winnerIdx.value = -1; frameId = 0; timeSec = 0
  running.value = true
  last = performance.now()
  requestAnimationFrame(frame)
}

function pause(){ running.value = false }
function resume(){ if (!device) return; running.value = true; last = performance.now(); requestAnimationFrame(frame) }

async function reset() {
  running.value = false
  if (!device) return
  allocBuffers(); build();
  N0 = cfg.count; lastAliveCPU = N0; gScaleCurrent = 1; winnerIdx.value = -1
}

onMounted(() => {
  const onResize = () => resize()
  window.addEventListener('resize', onResize)
  onBeforeUnmount(() => window.removeEventListener('resize', onResize))
})

// --- tiny rng ---
function mulberry32(a: number){ let t = a>>>0; return ()=>{ t+=0x6D2B79F5; let r=Math.imul(t^t>>>15,t|1); r^=r+Math.imul(r^r>>>7,r|61); return ((r^r>>>14)>>>0)/4294967296 } }
</script>

<template>
  <div class="bg-[#0b1020] min-h-screen text-slate-200">
    <div class="space-y-4 mx-auto p-4 md:p-6">
      <header class="flex justify-between items-center gap-4">
        <h1 class="font-bold text-2xl md:text-3xl tracking-tight">Followers Fight — WebGPU</h1>
        <div class="flex items-center gap-2">
          <button @click="start" class="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-2xl">Start</button>
          <button @click="pause" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-2xl">Pause</button>
          <button @click="resume" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-2xl">Resume</button>
          <button @click="reset" class="bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-2xl">Reset</button>
        </div>
      </header>

      <section class="gap-4 grid grid-cols-1 lg:grid-cols-3">
        <div class="space-y-4 lg:col-span-1">
          <div class="space-y-3 bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
            <h2 class="font-semibold">Parameters</h2>
            <div class="gap-3 grid grid-cols-2 text-sm">
              <LabeledNumber label="Particles" v-model.number="cfg.count" :min="1000" :max="2000000" :step="1000" />
              <LabeledNumber label="Seed" v-model.number="seed" :min="0" :max="999999" />

              <LabeledNumber label="HP" v-model.number="cfg.baseHp" :min="1" :max="2000" />
              <LabeledNumber label="Damage min" v-model.number="cfg.damageMin" :min="0" :max="200" />
              <LabeledNumber label="Damage max" v-model.number="cfg.damageMax" :min="0" :max="400" />

              <LabeledRange label="Elasticity" v-model.number="cfg.elasticity" :min="0" :max="1" :step="0.01" />
              <LabeledRange label="Base speed" v-model.number="cfg.speed" :min="0.2" :max="3" :step="0.05" />
              <LabeledNumber label="Min speed (px/s)" v-model.number="cfg.minSpeed" :min="0" :max="2000" />
              <LabeledNumber label="Max speed (px/s)" v-model.number="cfg.maxSpeed" :min="10" :max="5000" />
              <LabeledNumber label="Accel on hit (×)" v-model.number="cfg.accelOnHit" :min="1" :max="3" :step="0.01" />
              <LabeledNumber label="Accel on wall (×)" v-model.number="cfg.accelOnWall" :min="1" :max="3" :step="0.01" />
              <LabeledNumber label="Jitter (px/s²)" v-model.number="cfg.jitter" :min="0" :max="500" />

              <LabeledNumber label="Radius min" v-model.number="cfg.radiusMin" :min="1" :max="30" />
              <LabeledNumber label="Radius max" v-model.number="cfg.radiusMax" :min="1" :max="60" />

              <LabeledNumber label="Death fade (ms)" v-model.number="cfg.deathFadeMs" :min="50" :max="4000" :step="50" />
              <LabeledRange label="Death shrink" v-model.number="cfg.deathShrink" :min="0" :max="1" :step="0.05" />

              <label class="flex items-center gap-2 col-span-2 text-sm">
                <input type="checkbox" v-model="cfg.growthEnabled" class="accent-emerald-500">
                <span>Grow as players die</span>
              </label>
              <LabeledNumber label="Growth max scale" v-model.number="cfg.growthMaxScale" :min="1" :max="10" :step="0.05" />
              <LabeledNumber label="Growth exponent" v-model.number="cfg.growthExponent" :min="0.25" :max="3" :step="0.05" />
              <LabeledNumber label="Growth start survivors" v-model.number="cfg.growthStartSurvivors" :min="0" :max="1" :step="0.05" />
              <LabeledNumber label="Growth full survivors" v-model.number="cfg.growthFullSurvivors" :min="0" :max="1" :step="0.05" />
              <LabeledNumber label="Growth smooth (s)" v-model.number="cfg.growthSmoothSec" :min="0" :max="2" :step="0.05" />

              <label class="flex items-center gap-2 col-span-2 text-sm">
                <input type="checkbox" v-model="cfg.enableCollisions" class="accent-emerald-500"/>
                <span>Collisions (grid, approximate)</span>
              </label>
              <label class="flex items-center gap-2 col-span-2 text-sm">
                <input type="checkbox" v-model="cfg.endless" class="accent-emerald-500"/>
                <span>Endless mode (respawn)</span>
              </label>
            </div>
            <p class="text-slate-400 text-xs">This version uses <b> Webgpu </b>: integration, rebounds, approximate conflicts and death/growth are performed in compute. Growth - from the proportion of those who remain.</p>
          </div>
        </div>

        <div class="space-y-3 lg:col-span-2">
          <div class="border border-slate-700/50 rounded-2xl overflow-hidden">
            <canvas ref="canvasRef" class="block bg-[#0b1020] w-full h-auto"  />
          </div>
          <div class="flex items-center gap-4 text-slate-400 text-xs">
            <span>{{ statsText }}</span>
            <span v-if="winnerIdx>=0">• Winner: #{{ winnerIdx }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
