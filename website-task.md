# Website task

Task prompt for building the SuperColony site. Copy the block below and submit
it as an IMD task.

---

Build a simple static website for SuperColony.

Deliver one HTML file with inline CSS and JavaScript. No build step. Fetch the
logos once and inline them, so the finished file works offline with no
external references.

**Logos** (public, no auth):

- Header logo: https://raw.githubusercontent.com/Duggy-AI/supercolony/main/brand/supercolony-sc-lockup-currentcolor.svg
- Favicon mark: https://raw.githubusercontent.com/Duggy-AI/supercolony/main/brand/supercolony-sc-mark-currentcolor.svg

Both use `currentColor` for the cells and wordmark, so set CSS `color` on the
parent: `#0B1B3F` on light, `#FFFFFF` on dark. The two amber cells and the
navy dot inside each one stay fixed. Use this artwork as given. Do not redraw
or substitute it. If a URL does not load, stop and say so.

For the favicon, embed the mark as a percent-encoded `data:image/svg+xml` URI
with an explicit fill, since `currentColor` has nothing to inherit there.

**Colors:** Colony Navy `#0B1B3F` carries the brand. Core Amber `#FFB21E` is
for the agent core and primary actions only. White `#FFFFFF`.

**Type:** Space Grotesk Bold for headings, IBM Plex Mono for small labels,
both from Google Fonts with real system fallbacks. The wordmark is already
outlined, so it needs no font.

**Logo rules:** keep one cell width of clear space, amber cells stay amber on
every background, full logo at 120px wide or more and the mark alone below
that, no stretching, rotating, shadows or gradients.

**Content:**

- SuperColony is a local agent for posting IMD tasks.
- Tagline: "Just describe your idea. Your key stays on your computer."
- Install: `npm install -g supercolony`, then run `supercolony`.
- Footer links: https://github.com/Duggy-AI/supercolony ·
  https://x.com/supercolony_ai · https://www.npmjs.com/package/supercolony ·
  https://imd.fun

**Requirements:** single file, works offline from disk, responsive to 400px
with no horizontal scroll, light and dark via `prefers-color-scheme`, alt text
on the logo, visible focus states, AA contrast.

---

Full brand kit and usage rules: [`brand/`](./brand/)
