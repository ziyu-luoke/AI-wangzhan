import { useSyncExternalStore } from 'react'
import { store } from './store.js'

// 让组件订阅 store，store.emit() 后自动重渲染
export function useStoreState() {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
