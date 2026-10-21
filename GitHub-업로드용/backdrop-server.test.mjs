import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackdropClient } from './backdrop-server.mjs';
// Official data.go.kr embedded Swagger for /detailImage2 was inspected 2026-10-20.
// Source: https://www.data.go.kr/data/15101578/openapi.do
// Response field cpyrhtDivCd description explicitly lists:
// 저작권 유형 (Type1:제1유형(출처표시-권장), Type3:제3유형(제1유형+변경금지)
// Fixtures follow the published schema; they are not claimed to be live image responses.
const image = 'http://tong.visitkorea.or.kr/cms/resource/04/3304404_image3_1.jpg';
function fixture(url, patch = {}) {
  return new Response(JSON.stringify({ response: { header: { resultCode: '0000' }, body: { items: { item: [{ contentid: new URL(url).searchParams.get('contentId'), cpyrhtDivCd: 'Type1', smallimageurl: image, imgname: '관광사진', ...patch }] } } } }));
}
test('fixed destinations, Type1, HTTPS images, attribution and six-hour cache', async () => {
  let calls = 0, time = 0;
  const client = createBackdropClient({ serviceKey: 'secret/key', now: () => time, fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'manual'); assert.equal(new URL(url).searchParams.get('serviceKey'), 'secret/key'); return fixture(url);
  } });
  const [a,b] = await Promise.all([client.getPhotos(), client.getPhotos()]);
  assert.equal(calls, 3); assert.deepEqual(a,b); assert.equal(a.items.length,3);
  assert.match(a.items[0].imageUrl, /^https:/); assert.equal(a.items[0].cpyrhtDivCd,'Type1'); assert.ok(a.items[0].sourceUrl);
  a.items.length=0; assert.equal((await client.getPhotos()).items.length,3);
  time = 6 * 60 * 60 * 1000; await client.getPhotos(); assert.equal(calls,6);
});

test('upstream redirects are rejected without following their target or accepting image data', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const requests = [];
    const client = createBackdropClient({ serviceKey: 'secret/key', fetchImpl: async (url, options) => {
      requests.push(new Request(url, options));
      assert.equal(options.redirect, 'manual');
      return new Response(await fixture(url).text(), { status, headers: { Location: 'https://other.example/photos' } });
    } });
    assert.deepEqual((await client.getPhotos()).items, []);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(request => new URL(request.url).hostname === 'apis.data.go.kr'));
  }
});
test('validated full-size original is preferred over a thumbnail', async () => {
  const original = 'http://tong.visitkorea.or.kr/cms/resource/04/3304404_image2_1.jpg';
  const client = createBackdropClient({serviceKey:'secret',fetchImpl:async url=>fixture(url,{originimgurl:original})});
  const result = await client.getPhotos();
  assert.equal(result.items.length,3);
  for (const item of result.items) assert.equal(item.imageUrl,original.replace('http:','https:'));
});

test('missing or unsafe original falls back to a validated thumbnail', async () => {
  for (const original of [undefined, '', 'https://evil.test/photo.jpg', image+'?key=secret',
    'https://tong.visitkorea.or.kr/elsewhere/photo.jpg',
    'https://secret@tong.visitkorea.or.kr/cms/resource/04/photo.jpg',
    'https://tong.visitkorea.or.kr/cms/resource/04/secret.jpg']) {
    const client=createBackdropClient({serviceKey:'secret',fetchImpl:async url=>fixture(url,{originimgurl:original})});
    const result=await client.getPhotos();
    assert.equal(result.items.length,3);
    for (const item of result.items) assert.equal(item.imageUrl,image.replace('http:','https:'));
  }
});

test('unknown or Type3 license, missing image and foreign hosts are rejected', async () => {
  for (const patch of [{cpyrhtDivCd: undefined}, {cpyrhtDivCd:'Type3'}, {smallimageurl:''}, {smallimageurl:'https://evil.test/photo.jpg'}, {smallimageurl:image+'?key=secret'}, {contentid:'999'}]) {
    const c=createBackdropClient({serviceKey:'secret',fetchImpl:async url=>fixture(url,patch)});
    assert.deepEqual((await c.getPhotos()).items,[]);
  }
});
test('errors and missing key are safe empty results without secret leakage', async () => {
  const c=createBackdropClient({serviceKey:'secret',fetchImpl:async()=>{throw Error('secret');}});
  assert.equal(JSON.stringify(await c.getPhotos()).includes('secret'),false);
  assert.deepEqual((await createBackdropClient().getPhotos()).items,[]);
});
test('empty and partial responses get short cache, in-flight calls deduplicate', async () => {
  let calls=0,time=0;
  const c=createBackdropClient({serviceKey:'secret',now:()=>time,fetchImpl:async url=>{calls++;return fixture(url,{cpyrhtDivCd:calls%3===1?'Type1':'Type3'});}});
  assert.equal((await c.getPhotos()).items.length,1); await c.getPhotos(); assert.equal(calls,3);
  time=300000; await c.getPhotos(); assert.equal(calls,6);
});
test('deadline includes stuck body reads and fetch which ignores abort', async () => {
  for (const fetchImpl of [()=>new Promise(()=>{}), async()=>new Response(new ReadableStream({start(){}}))]) {
    const c=createBackdropClient({serviceKey:'secret',timeoutMs:10,fetchImpl});
    assert.deepEqual((await c.getPhotos()).items,[]);
  }
});
test('original works without a thumbnail and metadata does not echo credentials', async () => {
  const c=createBackdropClient({serviceKey:'secret',fetchImpl:async url=>fixture(url,{smallimageurl:'',originimgurl:image,imgname:'secret',author:'secret',serialnum:'secret'})});
  const r=await c.getPhotos(); assert.equal(r.items.length,3); assert.equal(JSON.stringify(r).includes('secret'),false);
});
