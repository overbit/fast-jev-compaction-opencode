import assert from "node:assert/strict"
import { readFile, stat } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../site")
const html = await readFile(resolve(root, "index.html"), "utf8")
const css = await readFile(resolve(root, "styles.css"), "utf8")
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique")
assert.match(html, /<html lang="en">/)
assert.match(html, /name="viewport"/)
assert.match(html, /Illustrative example/)
assert.match(html, /Experimental/)

for (const match of html.matchAll(/\b(?:href|src|data-copy|aria-controls)="([^"]+)"/g)) {
  const value = match[1]
  const attribute = match[0].split("=")[0]
  if (attribute === "data-copy" || attribute === "aria-controls" || value.startsWith("#")) {
    assert.ok(ids.includes(value.replace(/^#/, "")), `Missing target: ${value}`)
    continue
  }
  if (/^https?:/.test(value)) continue
  assert.ok(!value.startsWith("/"), `Project Pages assets must be relative: ${value}`)
  const path = resolve(root, value)
  assert.ok(path === root || path.startsWith(root + sep), `Asset escapes site directory: ${value}`)
  await stat(path)
}

for (const match of css.matchAll(/url\("([^"]+)"\)/g)) await stat(resolve(root, match[1]))
await stat(resolve(root, ".nojekyll"))
await stat(resolve(root, "assets/OFL.txt"))
console.log("Static site validated: IDs, links, relative assets, fonts, and required notices.")
