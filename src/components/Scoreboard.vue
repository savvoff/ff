<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type PropType } from 'vue'

interface Particle {
  id: string | number
  name: string
  hp: number
  maxHp: number
  alive: boolean
}

const props = defineProps({
  particles: {
    type: Array as PropType<Particle[]>,
    required: true,
  },
})

/**
 * `tick` forces periodic re-renders in case `particles`
 * are mutated outside Vue reactivity.
 */
const tick = ref(0)
let timer: number | undefined

onMounted(() => {
  timer = window.setInterval(() => (tick.value += 1), 250)
})
onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const list = computed(() =>
  (props.particles || [])
    .slice()
    .sort(
      (a, b) =>
        Number(b.alive) - Number(a.alive) || b.hp - a.hp
    )
)
</script>

<template>
  <div class="bg-slate-800/60 p-4 border border-slate-700/50 rounded-2xl">
    <h2 class="mb-2 font-semibold">Scoreboard</h2>

    <div class="pr-1 max-h-64 overflow-auto">
      <ul class="space-y-2">
        <li
          v-for="p in list"
          :key="p.id"
          class="flex items-center gap-3"
        >
          <span
            class="inline-block rounded-full w-2 h-2"
            :class="p.alive ? 'bg-emerald-500' : 'bg-rose-500'"
          />
          <span class="truncate grow" :title="p.name">{{ p.name }}</span>

          <div class="bg-slate-700/60 rounded w-40 h-2 overflow-hidden">
            <div
              class="h-full"
              :style="{
                width: `${Math.max(0, Math.min(1, p.hp / p.maxHp)) * 100}%`,
                background: 'linear-gradient(90deg, #22c55e, #84cc16)',
              }"
            />
          </div>

          <span class="w-10 tabular-nums text-right">
            {{ Math.max(0, Math.floor(p.hp)) }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
