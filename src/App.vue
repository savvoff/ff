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
  <nav class="d-flex">
    <router-link class="p-4" to="/">Simulate</router-link>
    <router-link class="p-4" to="/gpu">GPU Simulate</router-link>
  </nav>
  <router-view />
</template>
