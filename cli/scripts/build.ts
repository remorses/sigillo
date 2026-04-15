// Cross-target builder for sigillo CLI Zig binary.
// Builds the standalone executable for each platform and copies it into dist/<platform>/sigillo.

import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Target = {
  name: string
  zigTarget: string
}

const rootDirectory = path.resolve(import.meta.dirname, '..')
const distDirectory = path.join(rootDirectory, 'dist')
const zigBinDirectory = path.join(rootDirectory, 'zig-out', 'bin')

// Read version from package.json so the Zig binary embeds the correct version string
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf-8'))
const packageVersion: string = packageJson.version

// host platform in the same format as target names (e.g. "linux-x64", "darwin-arm64")
const hostTarget = `${os.platform()}-${os.arch()}`

const targets: Target[] = [
  { name: 'darwin-arm64', zigTarget: 'aarch64-macos' },
  { name: 'darwin-x64', zigTarget: 'x86_64-macos' },
  { name: 'linux-arm64', zigTarget: 'aarch64-linux-musl' },
  { name: 'linux-x64', zigTarget: 'x86_64-linux-musl' },
  { name: 'win32-arm64', zigTarget: 'aarch64-windows-gnu' },
  { name: 'win32-x64', zigTarget: 'x86_64-windows-gnu' },
]

function runCommand({ command, args, cwd }: { command: string; args: string[]; cwd: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd,
      stdio: 'inherit',
    })
    child.on('error', (error) => {
      reject(error)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed with code ${String(code)}`))
    })
  })
}

function resolveExePath(): string | undefined {
  const candidates = ['sigillo', 'sigillo.exe'].map((fileName) => {
    return path.join(zigBinDirectory, fileName)
  })
  return candidates.find((candidate) => {
    return fs.existsSync(candidate)
  })
}

async function buildTarget({ target }: { target: Target }): Promise<void> {
  fs.rmSync(path.join(rootDirectory, 'zig-out'), { recursive: true, force: true })

  // When building for the host platform, omit -Dtarget so Zig uses the
  // native system include/lib paths.
  const isNativeBuild = target.name === hostTarget
  const zigArgs = isNativeBuild
    ? ['build', '-Doptimize=ReleaseFast', `-Dversion=${packageVersion}`]
    : ['build', '-Doptimize=ReleaseFast', `-Dtarget=${target.zigTarget}`, `-Dversion=${packageVersion}`]

  await runCommand({
    command: 'zig',
    args: zigArgs,
    cwd: rootDirectory,
  })

  const exePath = resolveExePath()
  if (!exePath) {
    throw new Error(`No executable found in ${zigBinDirectory}`)
  }

  const targetDirectory = path.join(distDirectory, target.name)
  fs.mkdirSync(targetDirectory, { recursive: true })

  const exeFileName = target.name.startsWith('win32') ? 'sigillo.exe' : 'sigillo'
  const destExePath = path.join(targetDirectory, exeFileName)
  fs.copyFileSync(exePath, destExePath)

  // Ensure executable permission on unix
  if (!target.name.startsWith('win32')) {
    fs.chmodSync(destExePath, 0o755)
  }
}

async function main(): Promise<void> {
  const requestedTargets = process.argv.slice(2)
  const selectedTargets = requestedTargets.length
    ? targets.filter((target) => {
        return requestedTargets.includes(target.name)
      })
    : targets

  if (selectedTargets.length === 0) {
    throw new Error(`No matching target. Available: ${targets.map((target) => target.name).join(', ')}`)
  }

  for (const target of selectedTargets) {
    await buildTarget({ target })
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
