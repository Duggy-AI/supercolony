# README screenshots

These images show the actual `DashboardApp` components, rendered with illustrative task, wallet, payment, and worker data. They do not show live funds, real payments, production worker availability, or a user's private wallet.

To regenerate on the Windows capture host:

```sh
node scripts/capture-readme.mjs
python scripts/render-readme.py
```

The Node capture script uses the existing development dependencies. The PNG renderer requires Python and Pillow (`python -m pip install Pillow`) and uses the host's Consolas font. This font and Python are only needed to generate screenshots; neither is required to run Supercolony or view the README.

Intermediate ANSI frames are written to `.local/readme-captures/`, which is ignored by Git. The renderer adds terminal window chrome and rasterizes the captured frames; it does not redraw or invent application controls.
