
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("luau-parser");

const { transformLuau } = require("../lib/transform");

test("standard profile renames locals and preserves globals and properties", () => {
    const source = `
local player = { Name = "Ada" }
local function greet(target)
    print(target.Name)
end
greet(player)
`;
    const result = transformLuau(source, { profile: "standard" });

    assert.equal(result.profile, "standard");
    assert.ok(result.renamedBindings >= 2);
    assert.match(result.output, /print/);
    assert.match(result.output, /\.Name/);
    assert.doesNotMatch(result.output, /\bplayer\b|\btarget\b/);
    assert.doesNotThrow(() => parse(result.output));
});

test("shadowed locals get distinct names and references stay bound", () => {
    const source = `
local value = 1
do
    local value = 2
    print(value)
end
return value
`;
    const result = transformLuau(source, { profile: "standard" });
    const names = [...result.output.matchAll(/local (__sp_[a-f0-9]+)/g)]
        .map(match => match[1]);

    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
});

test("method syntax leaves implicit self intact", () => {
    const source = `
local item = { value = 5 }
function item:getValue(scale: number): number
    return self.value * scale
end
return item:getValue(2)
`;
    const result = transformLuau(source, { profile: "standard" });

    assert.match(result.output, /function __sp_[a-f0-9]+:getValue/);
    assert.match(result.output, /return self\.value \* __sp_[a-f0-9]+/);
});

test("strong profile encodes string literals", () => {
    const source = 'local secret = "do not expose this"; print(secret)';
    const result = transformLuau(source, { profile: "strong" });

    assert.equal(result.profile, "strong");
    assert.equal(result.encodedStrings, 1);
    assert.doesNotMatch(result.output, /do not expose this/);
    assert.match(result.output, /bit32\.bxor/);
    assert.match(result.output, /Tampering detected: encoded payload changed/);
    assert.doesNotThrow(() => parse(result.output));
});

test("strong profile hides table keys, property access, and method names", () => {
    const source = `
local item = { SecretField = 5 }
function item:readSecret(amount)
    return self.SecretField + amount
end
print(item:readSecret(2))
`;
    const result = transformLuau(source, { profile: "strong" });

    assert.ok(result.encodedProperties >= 4);
    assert.doesNotMatch(result.output, /SecretField|readSecret/);
    assert.match(result.output, /bit32\.bxor/);
    assert.doesNotThrow(() => parse(result.output));
});

test("strong profile handles escaped and long-bracket strings", () => {
    const source = String.raw`local a = "\x41\255"; local b = [=[long
text]=]; print(a, b)`;
    const result = transformLuau(source, { profile: "strong" });

    assert.equal(result.encodedStrings, 2);
    assert.doesNotMatch(result.output, /long\ntext/);
});

test("rejects invalid profiles, oversized input, and malformed Luau", () => {
    assert.throws(() => transformLuau("return true", {
        profile: "unknown"
    }));
    assert.throws(() => transformLuau("a".repeat(1024 * 1024 + 1)));
    assert.throws(() => transformLuau('local s = "broken'));
});

test("returns source and output statistics", () => {
    const result = transformLuau("return true", {
        profile: "standard"
    });

    assert.equal(result.profile, "standard");
    assert.equal(result.inputBytes, Buffer.byteLength("return true"));
    assert.ok(result.outputBytes > 0);
});
