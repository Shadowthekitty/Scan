# Scan

A photo scanner for printed photos, in the spirit of Google PhotoScan. It runs
entirely in the browser on your phone, works offline once installed, and never
uploads your pictures anywhere.

## What it does

- **Finds the photo automatically.** A live outline follows the print in the
  camera view. Its edges are refined to sub-pixel accuracy before cropping.
- **Removes glare.** After the first shot, four dots appear near the corners of
  the photo. Move the phone so the circle covers each dot. The app captures
  automatically, aligns the five shots, and rebuilds every glared area from a
  shot where it was not shining.
- **Straightens perspective.** The true shape of the print is recovered even
  when you photograph it at an angle. It can snap to standard print sizes such
  as 4×6, 5×7, 3.5×5, square and Instax.
- **Scans album pages.** In "Album page" mode it finds every photo on a page
  and saves each one separately.
- **Turns sideways photos upright.** It uses on-device face detection and only
  rotates when it is confident.
- **Restores colour.** Four looks are available: Original, Auto, Restore faded
  (removes the red or yellow cast of old prints) and Black & white. You can
  also set brightness, contrast, shadows, highlights, saturation, warmth,
  sharpening, and dust and scratch removal.
- **Keeps the real date.** Enter "1987" or "1987-06-14" and the saved JPEG
  gets that date as the date taken. Google Photos and Apple Photos then file
  the scan under that year instead of the day you scanned it. Captions are
  saved too.
- **Edits are non-destructive.** Every scan keeps its glare-free source, so you
  can re-crop or re-colour it later.
- **Imports existing pictures.** Flatbed scans or older phone photos of prints
  get the same cropping and restoration.
- **Exports easily.** Share straight to Photos or Google Photos, or download
  one file or a ZIP of many.

## Using it on your phone

The camera only works on a secure (https) address, so the app needs to be
hosted. Any static host works because there is no server code. Pick one:

1. **Netlify Drop (quickest, free).** Download this repository as a ZIP and
   unzip it. Drag the folder onto <https://app.netlify.com/drop>. You get an
   https link straight away.
2. **Cloudflare Pages (free, works with private repositories).** Create a
   Pages project connected to this repository. Leave the build command empty
   and set the output directory to `/`.
3. **GitHub Pages.** This needs a public repository or a paid GitHub plan for
   private ones. Set *Settings → Pages → Source* to *GitHub Actions*, then run
   the "Deploy to GitHub Pages" workflow from the Actions tab.

Open the link on your phone, then install it. On Android Chrome use *⋮ →
Install app* or *Add to Home screen*. On iPhone Safari use *Share → Add to Home
Screen*. The first start downloads the 13 MB scanning engine. After that it
works without a connection.

To try it on a computer, run this in the project folder and open
<http://localhost:8000>:

```sh
python3 -m http.server 8000
```

## Tips for the best scans

- Put the photo on a plain, darker surface that contrasts with its border.
- Fill most of the frame with the photo, but keep all four edges visible.
- Hold the phone roughly parallel to the photo for the first shot. Tilting it
  toward each dot is what moves the glare out of the way.
- If a corner is off, use *Crop* in the editor. Drag the corner while watching
  the magnifier.
- Turn on *Save without reviewing* in Settings to scan a box of photos
  quickly, then edit later from the library.

## Privacy and storage

Everything is processed on the device. Scans are stored in the browser's own
storage (IndexedDB). Clearing site data or uninstalling the app deletes them,
so save or share the ones you want to keep in your main photo library.

## How it works

The image processing runs in a Web Worker using OpenCV compiled to
WebAssembly. The steps are:

1. **Detection.** Canny edges on brightness, colour (Lab) and saturation
   channels feed a contour search. Each candidate quadrilateral is scored by
   how well its sides follow real edges. Each side is then refitted to the
   strongest nearby gradient at higher resolution.
2. **Tracking.** During the guided shots, points are followed from frame to
   frame with optical flow, and each is tied to its place in the first shot,
   so the photo's position is always fitted directly. Every few frames ORB
   matching against stored keyframes re-anchors the track. Each re-anchor is
   verified by overlaying the images, which rejects false matches on patterned
   tables. Blown-out glare is masked out, and the first shot waits until the
   phone is steady after you tap. `tests/tracking.test.mjs` checks this on a
   simulated handheld phone.
3. **Alignment.** ORB matching with RANSAC, then refinement with pyramidal
   Lucas-Kanade flow, lands each extra shot on the first to about a pixel.
4. **Glare merge.** Exposure is matched per channel. Glare only adds light, so
   each pixel is weighted by how much brighter it is than the second-darkest
   reading across shots. The first shot is favoured where there is no glare,
   which keeps it sharp. Weights are smoothed to avoid seams.
5. **Rectification.** The print's real aspect ratio is estimated from the
   perspective (Zhang & He's whiteboard method), then warped with cubic
   interpolation.
6. **Album pages.** Edges alone cannot tell a print from a rectangle inside
   it, like a window, a TV or a picture frame. So the page colour is learned
   from flat areas, trying a few candidates in case the table shows. The page
   is then taken as the connected stretch of that colour, walled off by edges.
   An outline counts as a print when every side follows a real edge, just
   outside it is page, and inside it is not. When a whole album page is found
   on a table, the search repeats inside it. On the live preview each outline
   must show up in two of the last four detections, so the display does not
   flicker.
7. **Restoration.** Tone curves are built from the photo's histograms,
   followed by CLAHE on lightness, saturation and unsharp masking. Dust
   removal uses morphological top-hat and black-hat filters, a size filter,
   and inpainting.

## Development

The app is plain HTML, CSS and JavaScript with no build step. The pipeline
tests run in Node against synthetic scenes with known geometry and glare:

```sh
npm test
```

| File | Purpose |
| --- | --- |
| `js/pipeline.js` | All image processing; shared by the worker and the tests |
| `js/worker.js` | Worker that owns OpenCV, captured frames and open edits |
| `js/capture.js`, `js/camera.js` | Camera screen, live outline, guided glare shots |
| `js/editor.js`, `js/saver.js` | Editor and saving |
| `js/library.js`, `js/db.js` | Library, viewer, album review, storage |
| `js/exif.js`, `js/zip.js` | EXIF writer (date taken, caption) and ZIP export |
| `sw.js` | Offline cache. Bump `VERSION` when you change files |

See `THIRD_PARTY_NOTICES.md` for the bundled OpenCV.js build and face model.
