# Third-party resources

The application retains the notices supplied with redistributed map resources. Application licensing is not changed by this migration.

- Noto Sans CJK SC 2.004: SIL Open Font License, see `resources/maps/static/vendor/Noto-LICENSE.txt` (installed package: `dist/maps/static/vendor/Noto-LICENSE.txt`).
- MapLibre GL JS 5.6.1: BSD 3-Clause, see `maplibre-LICENSE.txt` in the same directories.
- gcoord 1.0.7: MIT, see `gcoord-LICENSE.txt` in the same directories.
- GeoNames China administrative snapshot: CC BY 4.0; attribution, source URL and source SHA-256 are embedded in `resources/maps/data/cities-cn.json`. This is a dated source snapshot, not a current official administrative registry.

`resources/maps/data/assets.json` records original resource URLs and SHA-256 values. These files are included in the production package; the release verifier checks their hashes. Resource relocation does not change their bytes or licences.

Node dependencies retain their own licences in installed packages, including libxml2-wasm/libxml2, SQLite/better-sqlite3, Sharp/libvips, React/Radix UI, Playwright/Chromium and exiftool-vendored/ExifTool. Track overview tiles use geojson-vt 4.0.3 (ISC) and vt-pbf 3.1.3 (MIT), with their respective licences retained in the installed packages. External ffmpeg and Perl are installed separately and retain their own notices. Basemap sources retain provider attribution on the interactive map and exported images; availability and use terms depend on the selected provider.

## shadcn/ui

Components in `src/web/components/ui` are adapted from the official shadcn/ui new-york-v4 registry (https://ui.shadcn.com), retrieved on 2026-10-15. Imports, Chinese labels and the Vite toast theme are adjusted for this application.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
