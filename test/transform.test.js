
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    minifyLuau,
    transformLuau
} = require("../lib/transform");

test("removes line comments", () => {
    assert.equal(
        minifyLuau("local x = 1 -- comment\nreturn x"),
        "local x=1 return x"
    );
});

test("preserves quoted strings", () => {
    const source = `local s = "hello -- world"\nreturn s`;
    const output = minifyLuau(source);

    assert.ok(output.includes('"hello -- world"'));
});

test("preserves long-bracket strings", () => {
    const source = "local s = [=[hello\nworld]=]\nreturn s";
    const output = minifyLuau(source);

    assert.ok(output.includes("[=[hello\nworld]=]"));
});

test("rejects unterminated strings", () => {
    assert.throws(() => minifyLuau('local s = "broken'));
});

test("rejects oversized input", () => {
    assert.throws(() => minifyLuau("a".repeat(2 * 1024 * 1024 + 1)));
});

test("rejects unknown profiles", () => {
    assert.throws(() => minifyLuau("return true", {
        profile: "unknown"
    }));
});

test("returns output statistics", () => {
    const result = transformLuau("return true", {
        profile: "standard"
    });

    assert.equal(result.output, "return true");
    assert.equal(result.profile, "standard");
    assert.ok(result.outputBytes > 0);
});
