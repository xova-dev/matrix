import { contextBridge } from 'electron'
import { matrix } from 'virtual:matrix/runtime/preload'

contextBridge.exposeInMainWorld('desktopRuntime', matrix)
