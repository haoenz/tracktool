# Third-party resources

The application retains the notices supplied with redistributed map resources. Application licensing is not changed by this migration.

- Noto Sans CJK SC 2.004: SIL Open Font License, see `resources/maps/static/vendor/Noto-LICENSE.txt` (installed package: `dist/maps/static/vendor/Noto-LICENSE.txt`).
- MapLibre GL JS 5.6.1: BSD 3-Clause, see `maplibre-LICENSE.txt` in the same directories.
- gcoord 1.0.7: MIT, see `gcoord-LICENSE.txt` in the same directories.
- GeoNames China administrative snapshot: CC BY 4.0; attribution, source URL and source SHA-256 are embedded in `resources/maps/data/cities-cn.json`. This is a dated source snapshot, not a current official administrative registry.

`resources/maps/data/assets.json` records original resource URLs and SHA-256 values. These files are included in the production package; the release verifier checks their hashes. Resource relocation does not change their bytes or licences.

Node dependencies retain their own licences in installed packages, including libxml2-wasm/libxml2, SQLite/better-sqlite3, Sharp/libvips, React/Ant Design, Playwright/Chromium and exiftool-vendored/ExifTool. Track overview tiles use geojson-vt 4.0.3 (ISC) and vt-pbf 3.1.3 (MIT), with their respective licences retained in the installed packages. External ffmpeg and Perl are installed separately and retain their own notices. Basemap sources retain provider attribution on the interactive map and exported images; availability and use terms depend on the selected provider.
