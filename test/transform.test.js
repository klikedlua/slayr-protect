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
    const names = [...result.output.matchAll(/local ([A-Za-z][A-Za-z0-9_]*)/g)]
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

    assert.match(result.output, /function [A-Za-z][A-Za-z0-9_]*:getValue/);
    assert.match(result.output, /return self\.value \* [A-Za-z][A-Za-z0-9_]*/);
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

test("strong profile encodes numbers in local initializers and return expressions", () => {
    const source = `
local base = 734819
local function calculate(value)
    local adjusted = value + 92731.625
    if adjusted > 800000 then
        return adjusted
    end
    return -19
end
return calculate(base)
`;
    const result = transformLuau(source, { profile: "strong" });

    assert.ok(result.encodedNumbers >= 4);
    assert.doesNotMatch(result.output, /\b734819\b|\b92731\.625\b|\b800000\b/);
    assert.match(result.output, /tonumber/);
    assert.doesNotThrow(() => parse(result.output));
});

test("strong profile scrambles if, while, repeat, and if-expression conditions", () => {
    const source = `
local count = 0
if count == 0 then
    count = count + 1
elseif count > 1 then
    count = 0
end
while count < 2 do
    count = count + 1
end
repeat
    count = count - 1
until count == 1
local result = if count == 1 then 41 elseif count > 1 then 42 else 43
return result
`;
    const result = transformLuau(source, { profile: "strong" });

    assert.equal(result.scrambledConditions, 6);
    assert.match(result.output, /\band\b/);
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

test("offline VM emits randomized standalone Luau for supported scripts", () => {
    const source = `
local secret = "vm-sensitive-text"
local total = 0
local item = { first = 1, second = 2 }
local function add(value, ...)
    local extra = select(1, ...)
    return value + extra
end
for _, value in pairs(item) do
    total += value
end
local callback = function(value)
    return add(value, 2)
end
local result = if total > 0 then callback(3) else 0
return result, total
`;
    const first = transformLuau(source, { profile: "vm" });
    const second = transformLuau(source, { profile: "vm" });

    assert.equal(first.profile, "vm");
    assert.ok(first.vmInstructions > 0);
    assert.ok(first.vmFunctions >= 3);
    assert.ok(first.vmConstants > 0);
    assert.doesNotMatch(first.output, /vm-sensitive-text|\bsecret\b|\bcallback\b/);
    assert.match(first.output, /bit32\.bxor/);
    assert.match(first.output, /Protected payload changed/);
    assert.doesNotMatch(first.output, /loadstring|HttpGet|debug\./i);
    assert.notEqual(first.output, second.output);
    assert.doesNotThrow(() => parse(first.output));
});

test("offline VM rejects syntax outside its supported subset", () => {
    assert.throws(
        () => transformLuau("local value = input :: string", {
            profile: "vm"
        }),
        /VM profile does not support/
    );
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
