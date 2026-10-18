
"use strict";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function minifyLuau(source, options = {}) {
    if (typeof source !== "string") {
        throw new TypeError("Source must be a string.");
    }

    if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
        throw new Error("Source exceeds the 2 MB limit.");
    }

    const profile = options.profile || "standard";
    if (!["light", "standard", "strong"].includes(profile)) {
        throw new Error("Unknown protection profile.");
    }

    let out = "";
    let i = 0;
    let pendingSpace = false;

    const isSpace = c => /\s/.test(c || "");
    const isWord = c => /[A-Za-z0-9_]/.test(c || "");

    function longLevel(pos) {
        if (source[pos] !== "[") return -1;
        let j = pos + 1;
        while (source[j] === "=") j++;
        return source[j] === "[" ? j - pos - 1 : -1;
    }

    function readLong(pos, level) {
        const open = "[" + "=".repeat(level) + "[";
        const close = "]" + "=".repeat(level) + "]";
        const end = source.indexOf(close, pos + open.length);
        if (end < 0) throw new Error("Unclosed long-bracket string or comment.");
        return end + close.length;
    }

    function emit(token) {
        if (!token) return;

        const prev = out[out.length - 1];
        const first = token[0];

        if (
            pendingSpace &&
            prev &&
            first &&
            (isWord(prev) && isWord(first) ||
             prev === "-" && first === "-" ||
             prev === "." && first === "." ||
             prev === "/" && first === "/" ||
             prev === "=" && first === "=" ||
             prev === "~" && first === "=" ||
             prev === "<" && (first === "=" || first === "<") ||
             prev === ">" && (first === "=" || first === ">"))
        ) {
            out += " ";
        }

        pendingSpace = false;
        out += token;
    }

    while (i < source.length) {
        const c = source[i];

        if (isSpace(c)) {
            pendingSpace = true;
            i++;
            continue;
        }

        // Comments
        if (c === "-" && source[i + 1] === "-") {
            const level = longLevel(i + 2);

            if (level >= 0) {
                i = readLong(i + 2, level);
            } else {
                i += 2;
                while (i < source.length &&
                       source[i] !== "\n" &&
                       source[i] !== "\r") {
                    i++;
                }
            }

            pendingSpace = true;
            continue;
        }

        // Quoted strings
        if (c === "'" || c === '"') {
            const quote = c;
            const start = i++;
            let closed = false;

            while (i < source.length) {
                if (source[i] === "\\") {
                    i += 2;
                    continue;
                }

                if (source[i] === quote) {
                    i++;
                    closed = true;
                    break;
                }

                if (source[i] === "\n" || source[i] === "\r") {
                    throw new Error("Unterminated quoted string.");
                }

                i++;
            }

            if (!closed) throw new Error("Unterminated quoted string.");
            emit(source.slice(start, i));
            continue;
        }

        // Long-bracket strings
        if (c === "[") {
            const level = longLevel(i);

            if (level >= 0) {
                const start = i;
                i = readLong(i, level);
                emit(source.slice(start, i));
                continue;
            }
        }

        // Identifiers and numeric literals
        if (isWord(c)) {
            const start = i++;
            while (i < source.length && isWord(source[i])) i++;
            emit(source.slice(start, i));
            continue;
        }

        // Keep punctuation unchanged.
        emit(c);
        i++;
    }

    return out.trim();
}

function transformLuau(source, options = {}) {
    const output = minifyLuau(source, options);

    return {
        output,
        inputBytes: Buffer.byteLength(source, "utf8"),
        outputBytes: Buffer.byteLength(output, "utf8"),
        profile: options.profile || "standard",
        engine: "slayr-lexical-minifier"
    };
}

module.exports = {
    minifyLuau,
    transformLuau
};
