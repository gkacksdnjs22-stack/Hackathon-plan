import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PUBLIC_FILES } from './public-assets.mjs';
import { createHash } from 'node:crypto';

const window = {};
vm.runInNewContext(readFileSync(new URL('day-map.js', import.meta.url), 'utf8'), { window });
const helpers = window.TravelDayMap;
const place = (id, latitude, longitude) => ({ id, type: 'place', place: { name: id, address: '서울', latitude, longitude } });
test('map data preserves active visit order and numbering, excludes other event types and reports bad coordinates without mutating the note', () => {
  const day = { events: [place('one', 37.5, 127), { id: 'transfer-0', type: 'transfer' }, place('two', null, null), place('three', 35, 129), place('four', 0, 0), place('five', '37.5', 127)],
    hiddenEvents: [place('excluded', 37.5, 127)] };
  const before = JSON.stringify(day), points = helpers.placesForDay(day);
  assert.deepEqual(Array.from(points, item => item.eventId), ['one', 'two', 'three', 'four', 'five']);
  assert.deepEqual(Array.from(points, item => item.number), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(points, item => item.mapped), [true, false, true, false, false]);
  assert.equal(JSON.stringify(day), before); assert.equal(helpers.placesForDay({ events: [] }).length, 0);
});
test('coincident locations share their real coordinates and retain all visit numbers rather than hiding a marker', () => {
  const points = helpers.placesForDay({ events: [place('a', 37.5, 127), place('missing', null, null), place('b', 37.5, 127), place('c', 35, 129)] });
  const groups = helpers.groupsForPlaces(points);
  assert.deepEqual(Array.from(groups, group => Array.from(group, item => item.number)), [[1, 3], [4]]);
  assert.equal(groups[0][0].latitude, groups[0][1].latitude);
});
test('the shipped map library, CSS images and license are pinned and explicitly public', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.devDependencies.leaflet, '1.9.4');
  const hashes = { 'leaflet.js': '20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=', 'leaflet.css': 'p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=' };
  for (const [name, expected] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/leaflet/${name}`, import.meta.url))).digest('base64'), expected);
  const css = readFileSync(new URL('vendor/leaflet/leaflet.css', import.meta.url), 'utf8');
  for (const [, file] of css.matchAll(/url\(images\/([^)]+)\)/g)) assert.equal(PUBLIC_FILES.get(`vendor/leaflet/images/${file}`), 'image/png');
  assert.match(readFileSync(new URL('vendor/leaflet/LICENSE.txt', import.meta.url), 'utf8'), /Copyright/);
  assert.equal(PUBLIC_FILES.get('vendor/leaflet/LICENSE.txt'), 'text/plain; charset=utf-8');
});
