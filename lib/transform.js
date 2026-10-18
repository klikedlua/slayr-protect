"use strict";

const crypto = require("node:crypto");
const { parse, print } = require("luau-parser");
const { renameLocalBindings } = require("./obfuscator/rename-locals");
const {
    createDecoderSource,
    encodeStrong,
    extractLeadingDirectives,
} = require("./obfuscator/strong-encoding");

const MAX_SOURCE_BYTES = 1024 * 1024;
const PROFILES = new Set(["standard", "strong"]);

function validateSource(source, profile) {
    if (typeof source !== "string") {
        throw new TypeError("Source must be text.");
    }
    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        throw new Error("Source exceeds the 1 MB limit.");
    }
    if (!source.trim()) {
        throw new Error("Source is empty.");
    }
    if (!PROFILES.has(profile)) {
        throw new Error("Unknown profile.");
    }
}

function obfuscateLuau(source, profile = "standard") {
    validateSource(source, profile);

    const program = parse(source);
    const renamedBindings = renameLocalBindings(program, source);
    const encoded = profile === "strong"
        ? encodeStrong(program, source)
        : undefined;
    const encodedStrings = encoded?.encodedStrings ?? 0;
    const encodedNumbers = encoded?.encodedNumbers ?? 0;
    const encodedProperties = encoded?.encodedProperties ?? 0;
    const directives = extractLeadingDirectives(source);
    let output = print(program);

    if (encodedStrings > 0 || encodedNumbers > 0 || encodedProperties > 0) {
        output = createDecoderSource(
            encoded.decoderName,
            source,
            program,
            encoded.numberParserName,
        ) + output;
    }
    if (directives.length > 0) {
        output = `${directives.join("\n")}\n${output}`;
    }

    // Fail closed if the generated output is not valid Luau syntax.
    parse(output);

    return {
        output,
        profile,
        inputBytes: Buffer.byteLength(source, "utf8"),
        outputBytes: Buffer.byteLength(output, "utf8"),
        renamedBindings,
        encodedStrings,
        encodedNumbers,
        encodedProperties,
    };
}

function transformLuau(source, options = {}) {
    const profile = options && typeof options === "object"
        ? options.profile || "standard"
        : "standard";
    const result = obfuscateLuau(source, profile);

    return {
        ...result,
        buildId: crypto.randomBytes(8).toString("hex"),
    };
}

module.exports = {
    obfuscateLuau,
    transformLuau,
};
