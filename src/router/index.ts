import { createRouter, createWebHistory } from 'vue-router'

import Home from '@/views/Home.vue'
import Gpu from '@/views/Gpu.vue'
import Parser from '@/views/Parser.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'Home', component: Home },
    { path: '/gpu', name: 'GPU', component: Gpu },
    { path: '/parser', name: 'Parser', component: Parser },
  ],
})

export default router
