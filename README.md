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

It does not just colour the water. It decodes each satellite tile back to real
degrees using NASA's published colour scale, then measures how fast temperature
changes across distance and paints the fastest-changing water.

The sensitivity slider is **how much of the water on screen to highlight**, not an
absolute number. Set it to 8% and it finds the strongest-changing 8% of what you can
see, whatever the layer, season or region. The absolute figure it lands on is shown
next to the slider so you can still judge whether an edge is worth the fuel — offshore
Broome that is usually somewhere around 0.02–0.05 °C/km, and anything above about
0.1 °C/km is a hard edge.

It works this way because an absolute threshold does not survive contact with real
data. MUR SST is a smoothed analysis and an anomaly field is smoother again, so a
number that lights up a good edge in one layer paints nothing at all in another.

### Map type and date

The three buttons top-left switch between SST, chlorophyll and anomaly in one tap.
Below them, the arrows either side of the date step back and forward a day at a time
without opening settings. Forward greys out when you are on the newest imagery NASA
has published, because there is nothing after it.

Everything else — opacity, break sensitivity, cartography, current, FADs, units —
lives in **Settings** behind the menu button.

### Broome FADs

Four FADs are marked as standard. Tap one and you get the same readout as tapping
open water: temperature, chlorophyll and gradient at the FAD, plus range and bearing
from the boat. Save it and the mark keeps the FAD's name.

Positions are from the current official listing, where all four were showing *In
Position*. Each decimal pair was checked against the degrees-decimal-minutes on the
same record. **They are still not live.** FADs are moored, not fixed: they break away,
get retrieved and get moved. The app links to the official listing from Settings.

### Surface current

Arrows over the visible area, sampled on a grid, coloured and sized by speed. This is
broad-scale ocean current from a global model.

It is **not** the tidal stream. Inshore of Broome on a big tide the tide is what moves
the water, by a wide margin, and this layer will not show it. Read the arrows as
background drift and read the tide tab for the run.

### Marine cartography

Bathymetry and depth contours from the Esri Ocean basemap, GEBCO available as a deeper
relief layer, and OpenSeaMap seamarks — buoys, beacons, lights — as an optional
overlay.

None of this is an official chart. No soundings you should trust, no hazard data, no
survey authority behind it. It is for orientation. The plotter is for navigation.

### Imagery freshness

Settings shows the newest day NASA has actually published, how far behind real time
that is, and roughly when the next should appear. **Check for new imagery** re-queries
NASA on demand.

SST normally runs about a day behind. Chlorophyll runs one to two days behind and goes
blank under cloud. If the app opens on an older date than you expect, that is NASA,
not the app.

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
