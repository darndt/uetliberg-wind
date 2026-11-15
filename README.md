# Uetliberg Wind Lab

A browser-based 3D visualiser of how wind flows over the Uetliberg / Albis ridge near Zürich: ridge lift, sink and lee areas for any wind direction and speed. Built for understanding terrain flow as a paraglider pilot.

**It is not a flight-planning tool.** See [Limits](#limits).

## Run

The page needs a web server (it will not work opened as a file):

```sh
cd /Users/darndt/Development/uetliberg-wind
python3 -m http.server 8765
```

Then open <http://127.0.0.1:8765/index.html>. Everything is local; no internet is needed once the data is in `data/`.

## Using it

It starts with Bise (NE 50°, 20 km/h), neutral air and the Soaring band overlay.

| Control | What it does |
|---|---|
| Compass | Drag to set the direction the wind comes from (arrow keys: ±5°). |
| Speed | Free-stream wind above the ridge, 0–60 km/h. |
| Bise / Strong Bise | Presets: 50° at 20 km/h, 60° at 38 km/h. |
| Air mass | Stable / Neutral / Unstable: how readily air goes over rather than around the terrain. Re-solves the flow (about 1–2 s). |
| Ground overlay | Lee & turbulence, Soaring band, Lift / sink, Wind speed, or aerial image only. |
| Airflow | Tracer colour (lift/sink, speed, turbulence), number of tracers, and the height above ground up to which they are released. |

- **Mouse:** drag to orbit, right-drag to pan, scroll to zoom.
- **Probe:** click the terrain to move it. The probe window shows wind speed, direction and vertical speed at 10, 50, 150 and 300 m above ground.
- **Cross-section:** a vertical slice along the wind through the probe, with streamlines, the lee zone and a dashed contour around the region where a glider stays up.
- **Windows:** each of the three windows collapses with the chevron in its corner; the state is remembered in the browser.

Soaring band colours: green where air rises faster than 1.1 m/s somewhere between 25 and 190 m above ground and outside the lee; orange where that lift comes with more than 33 km/h of wind.

## How it works

- **Terrain:** a 14 × 14 km area centred on 47.350 N, 8.515 E, drawn at true vertical scale.
- **Flow:** a mass-consistent diagnostic wind model (the same family as WindNinja). A wind with a logarithmic height profile is forced to flow over and around the terrain on a 160 × 160 × 44 grid (about 88 m cells, 25 m layers near the ground). It runs in the browser in two web workers.
- **Instant direction and speed changes:** the model is linear in the inflow, so only two basis cases are solved (wind towards east, wind towards north) and every other wind is a combination of them.
- **Lee zones are a geometric rule, not simulated.** A point counts as sheltered when upwind terrain rises above it steeper than about 1:16 (fully in the wake at 1:4, looking up to about 2.3 km upwind). There the mean wind is reduced by up to 80% and tracers become turbulent.

## Limits

- The model cannot produce flow separation, rotors or reattachment; lee location is plausible, lee strength and exact extent are not.
- Not modelled: thermals, valley winds, gusts, lee waves, any change over time.
- Stability is a single factor on vertical motion, not a real temperature profile.
- The 1.1 m/s sink rate and 33 km/h wind limit are assumptions (`SINK` and `VMAX` in `js/main.js`).
- Nothing has been validated against measurements at Uetliberg.

## Files

| Path | Purpose |
|---|---|
| `index.html` | Page layout and styles. |
| `js/main.js` | Scene, controls, overlays, probe; defaults are in `state` near the top. |
| `js/solver.worker.js` | The flow solver. |
| `js/wind.js` | Combines the basis solutions for a given wind and applies the lee rule. |
| `js/terrain.js` | Decodes the elevation data and builds the terrain mesh. |
| `js/particles.js` | Flow tracers. |
| `js/section.js` | Cross-section drawing. |
| `js/palettes.js` | Colour scales. |
| `vendor/` | three.js 0.170 and its OrbitControls (the only library). |
| `data/` | `dem.png` (elevation), `ortho.jpg` (aerial image), `meta.json` (georeferencing). |
| `tools/fetch_data.py` | Downloads and stitches the data. |

## Changing the area

Edit `LAT0`, `LON0` and `SIZE_M` at the top of `tools/fetch_data.py`, then run:

```sh
python3 tools/fetch_data.py
```

It needs ImageMagick (`magick`) and internet access. The place labels and the initial probe position are set in `js/main.js` (`PLACES`). The aerial imagery only covers Switzerland; without it the terrain falls back to shaded relief.

## Data credits

- Elevation: Mapzen Terrain Tiles (AWS Open Data).
- Aerial imagery: SWISSIMAGE, © swisstopo.
