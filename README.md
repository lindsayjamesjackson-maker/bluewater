# Bluewater

Satellite sea surface temperature and chlorophyll for offshore fishing, built as an
installable web app. Opens on the water off Broome, follows your GPS, works with no
signal once you have saved the area.

## Putting it on the phone

The whole app is static files. It needs **HTTPS** — iOS will not give a web app
GPS access or offline storage over plain HTTP.

**On your own hosting (easiest, and the link is yours):**

1. Make a subdomain or folder, e.g. `bluewater.lindsayjackson.com.au`.
2. Upload everything in this folder, keeping the structure intact.
3. Open the URL on the iPhone in Safari (must be Safari, not Chrome).
4. Share button → **Add to Home Screen**.
5. Send the same link to your mates. They do step 3 and 4.

**Or drag-and-drop:** app.netlify.com/drop takes this folder and gives you an
HTTPS link in about ten seconds. Free, no account needed to start.

First launch needs signal — it pulls the colour scales and the current imagery date.
After that it will start up offline.

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
