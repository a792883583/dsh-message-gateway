/**
 * 构建脚本：只生成浏览器客户端打包结果（lib/client.js），
 * 已按 shell 的 __ModuleLoader__ 加载契约封装。本插件无宿主半区。
 * 外部依赖通过加载器的模块表（平台模块）解析，从不参与打包。
 */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Web shell 共享到冻结模块表中的模块标识符。 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
]

const clientBanner = `window.__ModuleLoader__.load({
  id: "dsh-message-gateway",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const clientFooter = `    return module.exports;
  }
});`

mkdirSync(dirname(`${root}/lib/client.js`), { recursive: true })

await Promise.all([
  // ---- host half: ESM, empty apply so the plugin appears in the host loader
  build({
    entryPoints: [`${root}/src/index.ts`],
    outfile: `${root}/lib/index.js`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-subprocess',
      '@deepseek-ai/dsh-workspace',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-llm',
      '@wecom/aibot-node-sdk',
    ],
    sourcemap: true,
    logLevel: 'warning',
  }),

  // ---- browser half: 由 window.__ModuleLoader__ 消费的闭包工厂
  build({
    entryPoints: [`${root}/src/client/index.ts`],
    outfile: `${root}/lib/client.js`,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: PLATFORM_MODULES,
    banner: { js: clientBanner },
    footer: { js: clientFooter },
    sourcemap: true,
    logLevel: 'warning',
  }),
])

console.log('✅ build done: lib/index.js + lib/client.js')
