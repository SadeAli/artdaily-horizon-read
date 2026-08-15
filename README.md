# Horizon Read 🌅

A daily perspective drill for [Art Daily](https://artdaily.sadeali.com/):
five procedural scenes hide the camera's eye level behind boxes, fence
posts and figures — you drag a line to where the horizon must be and
lock it in. Trains reading eye level from cues alone: tops show only
below it, undersides only above, same-height heads ride it, receding
rows converge straight to it.

The geometry is real, not decorative. Boxes are fronto-parallel solids
projected by pushing every front corner along its own ray to the
vanishing point (one shared depth ratio per box — the exact pinhole
result), and the fence is an evenly spaced post row projected with
`t_k = k·step / (k·step + depth)`, so the rhythm survives the
diagonal/halving check an artist would run on it.

Scoring is pure geometry: per scene `100 × clamp(1 − |dy| / (0.14·H), 0, 1)`,
round = mean of the five. Misses are reported in pixels **and** as a
percentage of frame height, so the number means the same thing on a
phone and on a desktop. Five chips under the canvas keep the round's
running scorecard.

After every lock-in the reveal draws the true line, every receding edge
extended to the vanishing point, and a ring around the one cue that
settled that scene — the thread you should have pulled. The reveal is
protected from double taps for a beat so it cannot be skipped by accident.

Input: drag anywhere on the canvas (grabbing near the line moves it by
delta, and slow moves travel at reduced gain for pixel placement; a press
far from the line drops it there), or ↑/↓ to nudge, shift+↑/↓ for 8px,
Enter to lock in and advance.

Run it: any static server, e.g. `python3 -m http.server 8080` — no build,
no deps. Part of [Art Daily](https://artdaily.sadeali.com/) ·
[sadeali.com](https://sadeali.com/).
