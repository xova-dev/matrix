import { contextBridge } from 'electron'
import { matrix } from 'virtual:matrix/runtime/preload'

if (matrix.isDevelopment)
  void import('../../../../shared/dev-only')

contextBridge.exposeInMainWorld('desktopRuntime', matrix)
