import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("GitHub Pages site", () => {
  it("validates project-relative assets and fragment/control targets", () => {
    const output = execFileSync(process.execPath, ["scripts/check-site.mjs"], { encoding: "utf8" })
    expect(output).toContain("Static site validated")
  })

  it("keeps both backend instructions available without JavaScript", () => {
    const html = readFileSync("site/index.html", "utf8")
    expect(html).toMatch(/id="hosted-panel" class="backend-panel">/)
    expect(html).toMatch(/id="local-panel" class="backend-panel">/)
    expect(html).toContain("not directly supported")
    expect(html).toContain("Illustrative example")
  })

  it("deploys only the public site, never from a pull request", () => {
    const workflow = readFileSync(".github/workflows/pages.yml", "utf8")
    expect(workflow).toContain("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'")
    expect(workflow).toContain("path: site")
    expect(workflow).toContain("needs: validate")
    expect(workflow).toContain("pages: write")
    expect(workflow).toContain("id-token: write")
    expect(workflow).not.toContain("secrets.")
  })
})
