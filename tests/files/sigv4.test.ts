import test from 'node:test';
import assert from 'node:assert/strict';
import { amzDate, EMPTY_SHA256, presignUrl, signHeaders, uriEncode } from '../../packages/data/src/files/index.js';

/**
 * SigV4 on node:crypto (FILE-001, no SDK dependency) against the published AWS Signature Version 4 examples for S3
 * (example credentials from the AWS documentation; they grant nothing).
 */
const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const at = new Date('2013-05-24T00:00:00Z');

test('presigned GET matches the AWS documentation example', () => {
  const url = presignUrl(credentials, { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt') }, at, 86400);
  assert.equal(url.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.ok(url.search.includes('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request'), 'query values are RFC 3986 encoded');
});

test('header authorization matches the AWS documentation example (GET with range)', () => {
  const headers = signHeaders(credentials, { method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 }, at);
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(headers['x-amz-date'], '20130524T000000Z');
});

test('presigned PUT signs the declared headers; changing them changes the signature', () => {
  const sign = (headers: Record<string, string>) => presignUrl(credentials, { method: 'PUT', url: new URL('http://127.0.0.1:8333/files/files/u/abc'), headers }, at, 300);
  const base = sign({ 'content-length': '10', 'content-type': 'image/png' });
  assert.equal(base.searchParams.get('X-Amz-SignedHeaders'), 'content-length;content-type;host');
  assert.notEqual(base.searchParams.get('X-Amz-Signature'), sign({ 'content-length': '11', 'content-type': 'image/png' }).searchParams.get('X-Amz-Signature'));
  assert.notEqual(base.searchParams.get('X-Amz-Signature'), sign({ 'content-length': '10', 'content-type': 'text/html' }).searchParams.get('X-Amz-Signature'));
  assert.throws(() => presignUrl(credentials, { method: 'GET', url: new URL('http://x/b/k') }, at, 0), RangeError);
  assert.throws(() => presignUrl(credentials, { method: 'GET', url: new URL('http://x/b/k') }, at, 604_801), RangeError);
});

test('encoding and dates', () => {
  assert.equal(uriEncode('a b/c+d~e', true), 'a%20b/c%2Bd~e');
  assert.equal(uriEncode('attachment; filename="file"'), 'attachment%3B%20filename%3D%22file%22');
  assert.deepEqual(amzDate(new Date('2026-11-01T09:08:07.654Z')), { dateTime: '20261101T090807Z', date: '20261101' });
});
