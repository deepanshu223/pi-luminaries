import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonlReader } from '../../src/jsonl.ts';

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

test('discards redundant summaries across chunks and continues at the next real event', () => {
  const { reader, values, errors } = collect({
    maxRecordBytes: 64,
    maxBufferBytes: 64,
    skipRecordPrefixes: ['{"type":"turn_end","message":', '{"type":"agent_end","messages":'],
  });
  reader.feed('{"type":"turn_');
  reader.feed('end","message":"');
  reader.feed('x'.repeat(4096));
  reader.feed('"}\r\n');
  reader.feed('{"type":"agent_end","messages":["' + 'x'.repeat(4096) + '"]}\n{"type":"agent_settled"}\n');
  reader.end();
  assert.deepEqual(errors, []);
  assert.deepEqual(values, [{ type: 'agent_settled' }]);
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
