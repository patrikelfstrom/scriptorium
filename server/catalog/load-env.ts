import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export function loadDotEnvFile(cwd = process.cwd()) {
  const envPath = path.resolve(cwd, ".env")

  if (!existsSync(envPath)) {
    return
  }

  const contents = readFileSync(envPath, "utf8")

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const [rawKey, ...rawValueParts] = trimmed.split("=")

    if (rawValueParts.length === 0) {
      continue
    }

    const key = rawKey.trim()

    if (!key || key in process.env) {
      continue
    }

    let value = rawValueParts.join("=").trim()

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}
