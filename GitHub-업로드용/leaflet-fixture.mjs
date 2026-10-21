// Leaflet boundary double: exercise app lifecycle and popup callbacks without
// making third-party tile requests in the automated regression suite.
export function leafletFixture() {
  const state = { maps: [], tiles: [], markers: [], groups: [] };
  const L = {
    map(element, options) {
      const map = { element, options, removed: false, views: [], fits: [], sizes: [], zoomControl: { setPosition() {} },
        setView(point, zoom, options) { this.views.push({ point, zoom, options }); return this; },
        fitBounds(points, options) { this.fits.push({ points, options }); return this; },
        invalidateSize(options) { this.sizes.push(options); return this; }, remove() { this.removed = true; } };
      state.maps.push(map); return map;
    },
    tileLayer(url, options) {
      const callbacks = new Map();
      const tiles = { url, options, on(type, callback) { callbacks.set(type, callback); return this; },
        addTo(map) { this.map = map; return this; }, emit(type) { callbacks.get(type)?.(); } };
      state.tiles.push(tiles); return tiles;
    },
    layerGroup() {
      const group = { markers: [], addTo(map) { this.map = map; return this; }, clearLayers() { this.markers = []; } };
      state.groups.push(group); return group;
    },
    divIcon(options) { return options; },
    marker(point, options) {
      const marker = { point, options, opens: 0, addTo(group) { group.markers.push(this); return this; },
        bindPopup(popup, options) { this.popup = popup; this.popupOptions = options; return this; }, openPopup() { this.opens++; return this; } };
      state.markers.push(marker); return marker;
    }
  };
  return { L, ...state };
}
