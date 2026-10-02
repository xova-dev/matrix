import { matrix } from 'virtual:matrix/runtime'

if (matrix.isDevelopment)
  void import('./dev-only')

export function showRuntime(page) {
  window.example = { page, ...matrix }
  document.querySelector('#runtime').textContent = JSON.stringify(window.example, null, 2)
}
