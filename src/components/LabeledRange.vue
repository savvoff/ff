<script setup lang="ts">
import { defineProps, defineEmits } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  modelValue: { type: Number, required: true },
  min: { type: Number, default: 0 },
  max: { type: Number, default: 1 },
  step: { type: Number, default: 0.01 },
})
const emit = defineEmits<{
  (e: 'update:modelValue', value: number): void
}>()

const onInput = (e: Event) => {
  const v = Number((e.target as HTMLInputElement).value)
  const clamped = Math.max(props.min, Math.min(props.max, v))
  emit('update:modelValue', clamped)
}
</script>

<template>
  <label class="flex flex-col gap-1">
    <span class="text-slate-400 text-xs">
      {{ props.label }}:
      <span class="font-medium text-slate-200">
        {{ props.modelValue.toFixed(2) }}
      </span>
    </span>

    <input
      type="range"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :value="props.modelValue"
      @input="onInput"
      class="accent-emerald-500"
    />
  </label>
</template>
