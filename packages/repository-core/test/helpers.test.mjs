import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { readBoundedStream } from '@jpahd/repository-core/bounded-stream';
import { decodeTextPreview } from '@jpahd/repository-core/text-preview';
import { parseRepositoryLog, REPOSITORY_LOG_FORMAT } from '@jpahd/repository-core/repository-log';

for (const web of [false, true]) {
  test(`bounded ${web ? 'Web' : 'Node'} stream drains every chunk without retaining overflow`, async () => {
    let count = 0;
    const source = Readable.from((async function* () {
      for (const value of ['abcd', 'efgh', 'ijkl']) {
        count++;
        yield Buffer.from(value);
      }
    })());
    const result = await readBoundedStream(web ? Readable.toWeb(source) : source, 6);
    assert.equal(new TextDecoder().decode(result.bytes), 'abcdef');
    assert.equal(result.truncated, true);
    assert.equal(count, 3);
  });
}

test('complete, uncapped, empty and invalid byte limits', async () => {
  assert.deepEqual(await readBoundedStream(Readable.from([Buffer.from('ok')]), 2), { bytes: new Uint8Array([111, 107]), truncated: false });
  assert.equal(new TextDecoder().decode((await readBoundedStream(Readable.from([Buffer.from('ok')]))).bytes), 'ok');
  assert.deepEqual(await readBoundedStream(Readable.from([]), 0), { bytes: new Uint8Array(), truncated: false });
  await assert.rejects(readBoundedStream(Readable.from([]), -1), /byte limit/);
});

test('preview decoding drops only a cut UTF-8 suffix, not malformed interiors', () => {
  assert.equal(decodeTextPreview(new Uint8Array([0x61, 0xf0, 0x9f]), true), 'a');
  assert.equal(decodeTextPreview(new Uint8Array([0x61, 0xf0, 0x9f]), false), undefined);
  assert.equal(decodeTextPreview(new Uint8Array([0x61, 0xff, 0x62]), true), undefined);
  assert.equal(decodeTextPreview(new Uint8Array([0]), false), undefined);
  assert.equal(decodeTextPreview(new TextEncoder().encode('\ufffd'), false), '\ufffd');
});

test('canonical log parser preserves ordinary control text and rejects invalid framing/encoding', () => {
  assert.match(REPOSITORY_LOG_FORMAT, /^%x00/);
  const sha = 'a'.repeat(40);
  const raw = ['', sha, 'aaaaaaa', 'subject\u001e\u001f', 'Author', 'author@example.test', '1700000000', '', ' body\n', '\n 1 file changed, 2 insertions(+), 1 deletion(-)\n'].join('\0');
  const bytes = new TextEncoder().encode(raw);
  const parsed = parseRepositoryLog(bytes);
  assert.equal(parsed[0].subject, 'subject\u001e\u001f');
  assert.equal(parsed[0].body, ' body\n');
  assert.equal(parsed[0].filesChanged, 1);
  assert.equal(parsed[0].additions, 2);
  assert.equal(parsed[0].deletions, 1);
  assert.throws(() => parseRepositoryLog(bytes.subarray(0, bytes.indexOf(0, 1))), /without loss/);
  assert.throws(() => parseRepositoryLog(new Uint8Array([0xff])), /without loss/);
  assert.deepEqual(parseRepositoryLog(new Uint8Array()), []);
});
