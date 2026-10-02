import path from 'pathe'

/** Only the main Vue module and its known script-block requests are eligible. */
export function isVueScriptRequest(id: string): boolean {
  if (!path.isAbsolute(id) || /[\0#]/.test(id))
    return false
  const [filename, query] = id.split('?', 2)
  if (query === undefined)
    return filename!.endsWith('.vue')
  const params = new URLSearchParams(query)
  if (!params.has('vue') || params.get('type') !== 'script')
    return false
  // Do not treat styles, templates, raw/url resources or arbitrary custom
  // queries as executable scripts just because their path ends in .vue.
  for (const key of params.keys()) {
    if (!['vue', 'type', 'setup', 'src', 'lang.js', 'lang.jsx', 'lang.ts', 'lang.tsx'].includes(key))
      return false
  }
  return filename!.endsWith('.vue') || (params.get('src') === 'true' && /\.[cm]?[jt]sx?$/.test(filename!))
}
