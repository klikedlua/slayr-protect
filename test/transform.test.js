
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { minifyLuau } = require('../lib/transform');

test('removes unnecessary whitespace', () => {
    const result = minifyLuau('local   x   =   123');
    assert.equal(result, 'local x = 123');
});

test('preserves quoted strings', () => {
    const result = minifyLuau('local message = "hello   world"');
    assert.equal(result, 'local message = "hello   world"');
});

test('removes line comments', () => {
    const result = minifyLuau('local x = 1 -- comment\nlocal y = 2');
    assert.equal(result, 'local x = 1 local y = 2');
});

test('preserves comment markers inside strings', () => {
    const result = minifyLuau('local url = "https://example.com"');
    assert.equal(result, 'local url = "https://example.com"');
});

test('rejects non-string input', () => {
    assert.throws(() => minifyLuau(null), TypeError);
});
