<script setup lang="ts">
import { onMounted, provide, ref } from 'vue'

const tailwindReady = ref(false)

function checkTailwind() {
  const test = document.createElement('div')
  test.className = 'hidden'
  document.body.appendChild(test)

  const style = window.getComputedStyle(test).display
  document.body.removeChild(test)

  if (style === 'none') {
    tailwindReady.value = true
  } else {
    setTimeout(checkTailwind, 50)
  }
}
provide('TAILWIND', tailwindReady)

onMounted(() => {
  checkTailwind()
})
</script>

<template>
  <nav class="d-flex bg-white">
    <router-link class="inline-block p-2" to="/">Simulate</router-link>
    <router-link class="inline-block p-2" to="/gpu">GPU Simulate</router-link>
    <router-link class="inline-block p-2" to="/parser">Parser</router-link>
  </nav>
  <router-view />
</template>

<style lang="scss">
  input[type="number"] { -moz-appearance: textfield; }
  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
</style>