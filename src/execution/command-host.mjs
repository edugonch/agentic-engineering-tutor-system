// This process owns the command group. If the plugin host disappears, reap the
// whole group instead of leaving detached verification commands running forever.
import { spawn } from "node:child_process"
const [owner, program, ...args] = process.argv.slice(2)
if (process.ppid !== Number(owner)) process.exit(125)
const monitor = setInterval(() => {
  if (process.ppid !== Number(owner)) {
    try { process.kill(-process.pid, "SIGKILL") } catch { process.exit(125) }
  }
}, 100)
const child = spawn(program, args, { shell: false, stdio: "inherit", env: process.env })
child.once("error", error => { console.error(error.message); clearInterval(monitor); process.exit(127) })
child.once("close", code => { clearInterval(monitor); process.exit(code ?? 1) })
