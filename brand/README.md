# SuperColony brand kit

Logo files and usage rules for SuperColony. These files are the source of
truth. Link to the raw URLs below rather than copying files elsewhere.

## Files

| File | Use |
|---|---|
| `supercolony-sc-lockup.svg` | Full logo, navy, for light backgrounds |
| `supercolony-sc-lockup-white.svg` | Full logo, white, for dark backgrounds |
| `supercolony-sc-mark.svg` | Mark only, navy. Favicons and small spaces |
| `supercolony-sc-mark-white.svg` | Mark only, white |
| `supercolony-sc-avatar.svg` | Square avatar, white mark on navy |
| `supercolony-sc-lockup-currentcolor.svg` | Full logo that follows CSS `color` |
| `supercolony-sc-mark-currentcolor.svg` | Mark that follows CSS `color` |

Each SVG has a matching PNG. Lockup PNGs are 2048 x 379, mark PNGs are
2048 x 1584, all with transparent backgrounds. The avatar PNG is 1024 x 1024
and opaque, sized for X, Telegram, Discord and GitHub, which crop it to a
circle safely.

## The currentColor files

The light and dark SVGs are identical apart from one fill, so the
`-currentcolor` versions replace that fill with `currentColor`. One file then
works on any background: set CSS `color` on the parent, `#0B1B3F` on light and
`#FFFFFF` on dark. The two amber cells and the navy dot inside each one are
fixed and do not follow `color`.

## Colors

| Name | Hex | Use |
|---|---|---|
| Colony Navy | `#0B1B3F` | Carries the brand |
| Core Amber | `#FFB21E` | The agent core and primary actions only |
| White | `#FFFFFF` | |

## Typeface

Space Grotesk Bold for the wordmark and headings, IBM Plex Mono for small
label text. Both are free on Google Fonts. The wordmark in the logo files is
already outlined, so no font is needed to display them.

## Using the logo

- Keep clear space around the logo of at least one honeycomb cell width.
- The two amber cells stay amber on every background. Only the other cells
  switch between navy and white.
- Use the full logo at 120px wide or more. Below that use the mark alone. The
  mark works down to 24px.
- Do not stretch, rotate, add shadows or gradients, or rearrange the cells.
