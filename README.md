# Bluewater

Satellite sea surface temperature and chlorophyll for offshore fishing, built as an
installable web app. Opens on the water off Broome, follows your GPS, works with no
signal once you have saved the area.

## Where it lives

The app is served by GitHub Pages straight from this repository. Every push
redeploys it automatically — there is no build step and nothing to upload.

**Live at:** `https://lindsayjamesjackson-maker.github.io/bluewater/`

### Putting it on the phone

1. Open that URL in **Safari** (not Chrome — only Safari can install to the home
   screen on iOS).
2. Share button → **Add to Home Screen**.
3. Send your mates the same link. They do the same two steps.

First launch needs signal — it pulls the colour scales and works out the current
imagery date. After that it starts up offline.

### Your own domain (optional)

To serve it from `bluewater.lindsayjackson.com.au` instead:

1. Add a DNS record at your registrar: `CNAME  bluewater  →  lindsayjamesjackson-maker.github.io`
2. In the repo: Settings → Pages → Custom domain → enter the subdomain → Save.
3. Tick **Enforce HTTPS** once the certificate is issued (usually a few minutes).

GitHub writes a `CNAME` file into the repo when you do this. Leave it there.

### Updating it

Ask Claude for a change. It edits the files here and pushes. Everyone picks up the
new version next time they open the app with signal — no reinstall, no re-adding to
the home screen.

The service worker caches aggressively on purpose, so when the app itself changes
(not just the data) the `APP` constant in `sw.js` gets bumped — `bw-app-v1` to
`bw-app-v2` and so on. That is what tells every installed copy to fetch the new
build.

### Self-hosting instead

The app is plain static files, so it will also run from any folder on normal
hosting. Drop the whole folder into `public_html/bluewater/` and it works at
`https://lindsayjackson.com.au/bluewater/`. The included `.htaccess` keeps
WordPress rewrite rules and plugins away from it and sets sane cache headers.
HTTPS is not optional — iOS gives a web app no GPS and no offline storage without
it.

## Using it

| | |
|---|---|
| **SST / Chl-a chip** (top left) | Switch layer, change opacity, wind the date back, turn breaks on |
| **Date chip** | Which day's satellite pass you are looking at |
| **Tap the map** | Reads out the actual temperature and chlorophyll at that spot, plus range and bearing from the boat |
| **Wave button** | Break finder on/off |
| **Arrow button** | Follow GPS. Tap again, or drag the map, to stop following |
| **Bottom sheet** | Drag up for conditions, tide and saved marks |
| **Download button** (top right) | Saves the area on screen to the phone |

### The break finder

This is the part worth understanding. It does not just colour the water — it decodes
each satellite tile back to real degrees, then measures how fast temperature changes
across distance. Anything steeper than the sensitivity you set gets painted orange,
brighter where the edge is harder.

Default is 0.10 °C/km. Wind it up to about 0.25 and only the hard edges survive,
which is usually what you want when you are picking one spot to run to. On the
chlorophyll layer it measures the same thing on a log scale, so a colour change from
0.1 to 0.3 mg/m³ reads as strongly as one from 1 to 3.

### Broome FADs

Four FADs are marked as standard. Tap one and you get the same readout as tapping
open water — the temperature, the chlorophyll and the gradient at the FAD, plus range
and bearing from the boat.

The coordinates come from Recfishwest's published sheets. Two separate Recfishwest
documents list the same four positions, which is why these are the ones in the app.
**They are not live.** FADs are moored, not fixed: they break away, get retrieved and
get redeployed, and DPIRD's own interactive map is the only current authority. The
app links to it from the layers panel. Check before you plan a trip around one.

### Surface current

Arrows over the visible area, sampled on a grid, coloured and sized by speed. This is
the broad-scale ocean current from a global model.

It is **not** the tidal stream. Inshore of Broome on a big tide the tide is what moves
the water, by a wide margin, and this layer will not show it. Read the arrows as
background drift and read the tide tab for the run.

### Marine cartography

Bathymetry and depth contours come from the Esri Ocean basemap, with GEBCO available
as a deeper relief layer. Seamarks — buoys, beacons, lights — come from OpenSeaMap,
which is crowd-sourced and optional.

None of this is an official chart. There are no soundings you should trust, no hazard
data and no survey authority behind it. It is for orientation. The plotter is for
navigation.

### Imagery freshness

The layers panel shows the newest day NASA has actually published, how far behind real
time that is, and roughly when the next one should appear. **Check for new imagery**
re-queries NASA on demand rather than waiting for the next app launch.

SST normally runs about a day behind. Chlorophyll runs one to two days behind and goes
blank under cloud. If the app opens on an older date than you expect, that is because
NASA has not posted anything newer yet, not because the app is stale.

### Tide

Computed on the phone from published harmonic constituents, so it works with no
signal at all. Broome, Derby, Port Hedland, Wyndham and 120-odd other Australian
ports are built in — it picks the closest to wherever you tapped. Heights are metres
above chart datum, the same reference the BOM tables use. It is an astronomical
prediction: a blow or a big pressure change will shift the real water level.

### Marks

Tap a spot, **Save mark**, and it stores the position along with the SST and
chlorophyll reading for that day. **Export GPX** from the Marks tab gives you a file
that imports straight into LightHouse on the Axiom, or Navionics.

## Offline

Tap the download button and it saves everything currently on screen: chart,
bathymetry, and the satellite layers for the selected day. Tick "last 5 days" if you
want to be able to compare while you are out there.

Roughly 20 MB per trip-sized area at the default detail. Do it on wi-fi. iOS will
keep it as long as you use the app reasonably often; if you leave it untouched for
weeks Safari may evict the storage and you will need to download the area again.

## What is under the hood

| Layer | Source | Notes |
|---|---|---|
| Chlorophyll-a | VIIRS on NOAA-21, via NASA GIBS | Daily, ~1 km |
| Sea surface temperature | GHRSST L4 MUR, via NASA GIBS | Daily blended analysis, gap-free |
| SST anomaly | GHRSST L4 MUR anomalies | How far today sits off the seasonal average |
| Chart and bathymetry | Esri Ocean Basemap, GEBCO | Contours and shelf edge |
| Wind, swell, current | Open-Meteo | Forecast models, free, no key |
| Tide | Neaps tide database (TICON-4), CC-BY-4.0 | Computed locally |

No API keys, no accounts, no server of your own. Everything either comes from a
public endpoint or runs on the phone.

## Known limits

- **Cloud kills the satellite layers.** SST is a blended analysis so it is usually
  gap-free, but chlorophyll is a direct optical measurement and goes blank under
  cloud. If today looks empty, wind the date back a day or two.
- **Imagery lags.** NASA publishes roughly a day behind. The date chip always opens
  on the newest day that actually exists.
- **Zoom.** NASA serves these layers to about 1 km resolution. Past that you are
  looking at the same pixels enlarged, which is fine for finding an edge and useless
  for anything finer.
- **Not a navigation instrument.** No official chart data, no depth soundings you
  should trust, no obstruction data. It tells you where the water changes. Your
  plotter tells you where the rocks are.

## Files

```
index.html              the app
app.js                  all the logic
styles.css              styling
sw.js                   service worker (offline)
manifest.webmanifest    home-screen install details
data/                   Australian tide harmonics
vendor/                 Leaflet, tide predictor (bundled, no CDN)
icons/                  app icons
```

Nothing is loaded from a CDN, so the app keeps working even if one goes down.
