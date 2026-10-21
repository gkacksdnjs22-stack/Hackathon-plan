# Leaflet 1.9.4

Unmodified runtime distribution from the pinned `leaflet@1.9.4` npm package.

- Upstream: https://leafletjs.com/download.html
- Source: https://github.com/Leaflet/Leaflet/tree/v1.9.4
- License: BSD-2-Clause, preserved in `LICENSE.txt` and the JavaScript header.
- `leaflet.js`, `leaflet.css` and `images/` are copied from `node_modules/leaflet/dist/` after `npm ci`.
- The regression suite checks the JS/CSS SHA-256 hashes published by Leaflet. Update the pinned version, copied files, cache versions and checksums together when upgrading.

This package renders the map. Background tiles are requested directly by the browser only when the active note's map is opened. Attribution is shown on the map and below the place list. Tile policy: https://operations.osmfoundation.org/policies/tiles/
