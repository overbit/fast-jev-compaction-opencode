const toggle = document.querySelector("#review-toggle")
const review = document.querySelector(".review")
const arrow = toggle.querySelector("svg").outerHTML

toggle.addEventListener("click", () => {
  const compacted = toggle.getAttribute("aria-pressed") !== "true"
  toggle.setAttribute("aria-pressed", String(compacted))
  review.classList.toggle("is-compacted", compacted)
  toggle.innerHTML = `${compacted ? "Show full example" : "Show retained context"}${arrow}`
  document.querySelector("#review-state").textContent = compacted ? "Retained checkpoint" : "Before compaction"
  document.querySelector("#review-count").textContent = compacted ? "4 illustrated entries retained" : "6 illustrated entries"
  document.querySelector(".full-output").hidden = compacted
  document.querySelector(".short-output").hidden = !compacted
})

const tabs = [...document.querySelectorAll('[role="tab"]')]
const panels = tabs.map(tab => document.getElementById(tab.getAttribute("aria-controls")))
document.querySelector(".backend-tabs").hidden = false
panels.forEach(panel => {
  panel.setAttribute("role", "tabpanel")
  panel.setAttribute("aria-labelledby", tabs[panels.indexOf(panel)].id)
  panel.tabIndex = 0
})

function activateTab(index, focus = false) {
  tabs.forEach((tab, current) => {
    const active = current === index
    tab.setAttribute("aria-selected", String(active))
    tab.tabIndex = active ? 0 : -1
    panels[current].hidden = !active
  })
  if (focus) tabs[index].focus()
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(index))
  tab.addEventListener("keydown", event => {
    let next
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length
    if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length
    if (event.key === "Home") next = 0
    if (event.key === "End") next = tabs.length - 1
    if (next !== undefined) {
      event.preventDefault()
      activateTab(next, true)
    }
  })
})
activateTab(0)

const copyStatus = document.querySelector("#copy-status")
let statusTimeout
document.querySelectorAll("[data-copy]").forEach(button => {
  button.addEventListener("click", async () => {
    button.disabled = true
    try {
      const value = document.getElementById(button.dataset.copy).textContent.trim()
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable")
      await navigator.clipboard.writeText(value)
      copyStatus.textContent = "Copied to clipboard."
    } catch {
      copyStatus.textContent = "Clipboard unavailable. Select the command and copy it manually."
    } finally {
      button.disabled = false
      clearTimeout(statusTimeout)
      statusTimeout = setTimeout(() => { copyStatus.textContent = "" }, 5000)
    }
  })
})
