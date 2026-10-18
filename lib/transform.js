"use strict";

const crypto = require("crypto");

const PROFILES = new Set(["standard", "strong"]);

function minifyLuau(source) {
    if (typeof source !== "string") {
        throw new TypeError("Source must be text.");
    }

    if (Buffer.byteLength(source, "utf8") > 2 * 1024 * 1024) {
        throw new Error("Source exceeds the 2 MB limit.");
    }

    let out = "";
    let i = 0;
    let previous = "";

    const isWord = c => !!c && /[A-Za-z0-9_]/.test(c);

    function append(token) {
        if (
            previous &&
            isWord(previous[previous.length - 1]) &&
            isWord(token[0])
        ) {
            out += " ";
        }

        out += token;
        previous = token;
    }

    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];

        if (/\s/.test(c)) {
            i++;
            continue;
        }

        // Line and block comments, including Lua long comments.
        if (c === "-" && next === "-") {
            let level = 0;
            let start = i + 2;

            if (source[start] === "[") {
                start++;

                while (source[start] === "=") {
                    level++;
                    start++;
                }

                if (source[start] === "[") {
                    const close = "]" + "=".repeat(level) + "]";
                    const end = source.indexOf(close, start + 1);

                    if (end === -1) {
                        throw new Error("Unterminated long comment.");
                    }

                    i = end + close.length;
                    continue;
                }
            }

            i += 2;

            while (i < source.length && source[i] !== "\n") {
                i++;
            }

            continue;
        }

        // Quoted strings.
        if (c === "'" || c === '"') {
            const quote = c;
            let token = source[i++];

            let closed = false;

            while (i < source.length) {
                const ch = source[i++];
                token += ch;

                if (ch === "\\") {
                    if (i < source.length) {
                        token += source[i++];
                    }
                } else if (ch === quote) {
                    closed = true;
                    break;
                }
            }

            if (!closed) {
                throw new Error("Unterminated string literal.");
            }

            append(token);
            continue;
        }

        // Lua long-bracket strings: [[...]], [=[...]=], etc.
        if (c === "[") {
            let j = i + 1;
            let level = 0;

            while (source[j] === "=") {
                level++;
                j++;
            }

            if (source[j] === "[") {
                const close = "]" + "=".repeat(level) + "]";
                const end = source.indexOf(close, j + 1);

                if (end === -1) {
                    throw new Error("Unterminated long string.");
                }

                const token = source.slice(i, end + close.length);
                append(token);
                i = end + close.length;
                continue;
            }
        }

        // Identifiers and numbers are copied without changing their spelling.
        if (isWord(c)) {
            let j = i + 1;

            while (j < source.length && isWord(source[j])) {
                j++;
            }

            append(source.slice(i, j));
            i = j;
            continue;
        }

        append(c);
        i++;
    }

    return out;
}

function transformLuau(source, options = {}) {
    const profile = options.profile || "standard";

    if (!PROFILES.has(profile)) {
        throw new Error("Unknown profile.");
    }

    const output = minifyLuau(source);

    if (!output.trim()) {
        throw new Error("Source is empty.");
    }

    return {
        output,
        profile,
        inputBytes: Buffer.byteLength(source, "utf8"),
        outputBytes: Buffer.byteLength(output, "utf8"),
        buildId: crypto.randomBytes(8).toString("hex")
    };
}

module.exports = { transformLuau };
