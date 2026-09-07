import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir, platform } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = resolve(fileURLToPath(import.meta.url), '..')
const pluginDir = resolve(__dirname, '..').replace(/\\/g, '/')
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = join(dshHome, 'profiles')

console.log(`\n🔍 检测 DSH 环境目录: ${dshHome}`)

if (!existsSync(profilesDir)) {
  console.error(`❌ 未找到 DSH profiles 目录: ${profilesDir}`)
  console.error(`请先确保本机已安装并运行过 DSH 初始化环境。`)
  process.exit(1)
}

// 获取需要挂载的 profiles
const targetProfiles = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
let profiles = targetProfiles.length > 0 ? targetProfiles : []

if (profiles.length === 0) {
  const entries = readdirSync(profilesDir, { withFileTypes: true })
  profiles = entries.filter(e => e.isDirectory() && e.name !== 'node_modules').map(e => e.name)
  if (profiles.length === 0) {
    profiles = ['web']
  }
}

let mountedCount = 0

for (const profile of profiles) {
  const pkgPath = join(profilesDir, profile, 'package.json')
  if (!existsSync(pkgPath)) {
    console.warn(`⚠️ Profile [${profile}] 缺少 package.json，跳过: ${pkgPath}`)
    continue
  }

  try {
    const raw = readFileSync(pkgPath, 'utf8')
    const pkg = JSON.parse(raw)

    pkg.dependencies = pkg.dependencies || {}
    pkg.dsh = pkg.dsh || {}
    pkg.dsh.profile = pkg.dsh.profile || {}
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []

    // 清理旧的 dsh-agent-cli（如有）
    if (pkg.dependencies && pkg.dependencies['dsh-agent-cli']) {
      delete pkg.dependencies['dsh-agent-cli']
    }
    if (pkg.dsh.profile.bundles.includes('dsh-agent-cli')) {
      pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter(b => b !== 'dsh-agent-cli')
    }

    // 1. 设置 dependencies 中的 link
    pkg.dependencies['dsh-devin-cli'] = `link:${pluginDir}`

    // 2. 检查并追加 bundles
    if (!pkg.dsh.profile.bundles.includes('dsh-devin-cli')) {
      pkg.dsh.profile.bundles.push('dsh-devin-cli')
    }

    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    console.log(`✅ [${profile}] 成功挂载插件到: ${pkgPath}`)
    console.log(`   └─ 链接路径: link:${pluginDir}`)

    // 3. 确保 profile 目录下的 node_modules 拥有 dsh-devin-cli 软链接（保证 DSH Loader 瞬间解析）
    const nmDir = join(profilesDir, profile, 'node_modules')
    if (!existsSync(nmDir)) {
      mkdirSync(nmDir, { recursive: true })
    }
    const oldLink = join(nmDir, 'dsh-agent-cli')
    const newLink = join(nmDir, 'dsh-devin-cli')
    if (existsSync(oldLink)) {
      rmSync(oldLink, { recursive: true, force: true })
    }
    if (existsSync(newLink)) {
      rmSync(newLink, { recursive: true, force: true })
    }
    try {
      symlinkSync(pluginDir, newLink, platform() === 'win32' ? 'junction' : 'dir')
      console.log(`   └─ 已自动建立 node_modules 软链接: ${newLink}`)
    } catch (symErr) {
      console.warn(`   └─ 提示: 创建软链接跳过 (${symErr.message})，可运行 'dsh plugin --profile ${profile} install' 完成链接`)
    }

    mountedCount++
  } catch (err) {
    console.error(`❌ 挂载 profile [${profile}] 失败:`, err)
  }
}

if (mountedCount > 0) {
  console.log(`\n🎉 挂载完成！共更新 ${mountedCount} 个 DSH Profile。`)
  console.log(`💡 后续步骤：`)
  console.log(`   1. 运行 DSH: dsh --profile web`)
  console.log(`   2. 打开 DSH Web 设置页面，即可看到 "Devin CLI" 独立面板并配置模型。\n`)
} else {
  console.warn(`\n⚠️ 没有成功更新任何 Profile。`)
}
