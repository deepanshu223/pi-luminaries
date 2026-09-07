import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeJsonLine, JsonlReader } from '../../src/jsonl.ts';

function collect(options = {}) {
  const values = [];
  const errors = [];
  const reader = new JsonlReader(
    (value) => values.push(value),
    options,
    (error) => errors.push(error),
  );
  return { reader, values, errors };
}

test('serializes one LF and preserves literal Unicode separators in JSON strings', () => {
  const line = serializeJsonLine({ text: 'before\u2028middle\u2029after', emoji: '😀' });
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.endsWith('\n\n'), false);
  assert.equal(JSON.parse(line).text, 'before\u2028middle\u2029after');
  assert.equal(line.includes('\n'), true);
  assert.equal(line.slice(0, -1).includes('\r'), false);
});

test('uses StringDecoder semantics for split UTF-8 and strips optional CR only', () => {
  const { reader, values, errors } = collect();
  const bytes = Buffer.from('{"text":"😀"}\r\n{"n":2}\n{"tail":true}\n', 'utf8');
  const split = bytes.indexOf(0x9f);
  reader.feed(bytes.subarray(0, split));
  reader.feed(bytes.subarray(split, split + 1));
  reader.feed(bytes.subarray(split + 1));
  reader.end();
  assert.deepEqual(values, [{ text: '😀' }, { n: 2 }, { tail: true }]);
  assert.deepEqual(errors, []);
});

test('rejects malformed, oversized, and parser-buffer records with explicit errors', () => {
  const malformed = collect();
  malformed.reader.feed('{not-json}\n');
  assert.equal(malformed.errors.length, 1);
  assert.match(malformed.errors[0].message, /Malformed JSONL/);
  malformed.reader.feed('{"after":true}\n');
  assert.deepEqual(malformed.values, []);
  assert.equal(malformed.errors.length, 1);

  const oversized = collect({ maxRecordBytes: 12, maxBufferBytes: 12 });
  oversized.reader.feed('{"long":"123456789"}\n');
  assert.equal(oversized.errors.length, 1);
  assert.match(oversized.errors[0].message, /exceeds/);

  const buffered = collect({ maxRecordBytes: 20, maxBufferBytes: 20 });
  buffered.reader.feed('{"unterminated":"xxxxxxxxxxxxxxxx"');
  assert.equal(buffered.errors.length, 1);
  assert.match(buffered.errors[0].message, /buffer|record/);
});

test('unterminated and empty records are malformed', () => {
  const final = collect();
  final.reader.feed('{"last":1}');
  final.reader.end();
  assert.deepEqual(final.values, []);
  assert.equal(final.errors.length, 1);
  assert.match(final.errors[0].message, /unterminated/);

  const empty = collect();
  empty.reader.feed('\n');
  assert.equal(empty.errors.length, 1);
});

test('record-handler failures are terminal without being mislabeled as malformed JSON', () => {
  const errors = [];
  const reader = new JsonlReader(
    () => {
      throw new Error('record handler failed');
    },
    {},
    (error) => errors.push(error),
  );
  reader.feed('{"valid":true}\n');
  reader.feed('{"ignored":true}\n');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'record handler failed');
});

test('serializer and reader enforce finite safe bounds', () => {
  assert.throws(() => serializeJsonLine({ long: '123456789' }, 10), /exceeds/);
  assert.throws(() => serializeJsonLine(undefined), /serializable/);
  assert.throws(() => serializeJsonLine({}, Number.POSITIVE_INFINITY), /positive safe integer/);
  assert.throws(() => serializeJsonLine({}, Number.NaN), /positive safe integer/);
  assert.throws(
    () => new JsonlReader(() => undefined, { maxRecordBytes: Number.POSITIVE_INFINITY }),
    /positive safe integers/,
  );
  assert.throws(() => new JsonlReader(() => undefined, { maxBufferBytes: Number.NaN }), /positive safe integers/);
});
