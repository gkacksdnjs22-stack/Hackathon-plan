import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { PUBLIC_FILES } from './public-assets.mjs';

test('user guide is bundled, linked from the footer and references only available local public assets', () => {
  const html = readFileSync(new URL('help.html', import.meta.url), 'utf8');
  const index = readFileSync(new URL('index.html', import.meta.url), 'utf8');
  assert.match(index, /href="\.\/help\.html"/);
  assert.equal(PUBLIC_FILES.get('help.html'), 'text/html; charset=utf-8');
  assert.match(html, /직접 편집/);
  assert.match(html, /0분이 걸린다는 뜻이 아니/);
  assert.match(html, /계정 기능이 설정된 경우에만/);
  for (const [, asset] of html.matchAll(/(?:href|src)="\.\/([^"#]+)"/g)) {
    const name = asset.split('?')[0];
    assert.ok(PUBLIC_FILES.has(name), name);
    assert.ok(existsSync(new URL(name, import.meta.url)), name);
  }
});

test('restaurant travel caveat remains on the meal card after the selection toast disappears', () => {
  const app = readFileSync(new URL('app.js', import.meta.url), 'utf8');
  assert.match(app, /travelNotice.textContent='식당을 담아도 오가는 이동시간은 자동으로 더해지지 않아요/);
  assert.match(app, /content.append\(travelNotice\)/);
});
