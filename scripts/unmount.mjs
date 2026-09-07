import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')

console.log(`\n🔍 检测 DSH 环境目录: ${dshHome}`)

if (!existsSync(profilesDir)) {
  console.error(`❌ 未找到 DSH profiles 目录: ${profilesDir}`)
  process.exit(1)
}

const targetProfiles = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
let profiles = targetProfiles.length > 0 ? targetProfiles : []

if (profiles.length === 0) {
  const entries = readdirSync(profilesDir, { withFileTypes: true })
  profiles = entries.filter(e => e.isDirectory() && e.name !== 'node_modules').map(e => e.name)
}

let unmountedCount = 0

for (const profile of profiles) {
  const pkgPath = join(profilesDir, profile, 'package.json')
  if (!existsSync(pkgPath)) continue

  try {
    const raw = readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw)

    let modified = false
    if (pkg.dependencies && pkg.dependencies['dsh-devin-cli']) {
      delete pkg.dependencies['dsh-devin-cli']
      modified = true
    }
    if (pkg.dependencies && pkg.dependencies['dsh-agent-cli']) {
      delete pkg.dependencies['dsh-agent-cli']
      modified = true
    }

    if (pkg.dsh?.profile?.bundles && pkg.dsh.profile.bundles.includes('dsh-devin-cli')) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-devin-cli')
      modified = true
    }
    if (pkg.dsh?.profile?.bundles && pkg.dsh.profile.bundles.includes('dsh-agent-cli')) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-agent-cli')
      modified = true
    }

    // 清理 node_modules 软链接
    const nmDir = join(profilesDir, profile, 'node_modules')
    const oldLink = join(nmDir, 'dsh-agent-cli')
    const newLink = join(nmDir, 'dsh-devin-cli')
    if (existsSync(oldLink)) rmSync(oldLink, { recursive: true, force: true })
    if (existsSync(newLink)) rmSync(newLink, { recursive: true, force: true })

    if (modified) {
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
      console.log(`✅ [${profile}] 成功卸载插件: ${pkgPath}`)
      unmountedCount++
    }
  } catch (err) {
    console.error(`❌ 卸载 profile [${profile}] 失败:`, err)
  }
}

console.log(`\n🎉 卸载完成，共从 ${unmountedCount} 个 Profile 中移除。\n`)
