# Horizon Read 🌅

A daily perspective drill for [Art Daily](https://artdaily.sadeali.com/):
five procedural scenes hide the camera's eye level behind boxes, fence
posts and figures — you drag a line to where the horizon must be and
lock it in. Trains reading eye level from cues alone: tops show only
below it, undersides only above, receding rows converge straight to it.

Scoring is pure geometry: per scene `100 × clamp(1 − |dy| / (0.14·H), 0, 1)`,
round = mean of the five. After every lock-in the true line and the cue
lines are revealed so you learn from the delta.

Run it: any static server, e.g. `python3 -m http.server 8080` — no build,
no deps. Part of [Art Daily](https://artdaily.sadeali.com/) ·
[sadeali.com](https://sadeali.com/).
