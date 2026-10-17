
'use strict';

// Basic Luau source minifier.
// This reduces whitespace; it is not encryption or strong obfuscation.

function minifyLuau(source) {
    if (typeof source !== 'string') {
        throw new TypeError('Source must be a string.');
    }

    let output = '';
    let i = 0;
    let quote = null;
    let longLevel = null;
    let lineComment = false;
    let blockCommentLevel = null;
    let pendingSpace = false;

    const isWord = (c) => c && /[A-Za-z0-9_]/.test(c);

    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];

        if (lineComment) {
            if (c === '\n' || c === '\r') {
                lineComment = false;
                pendingSpace = true;
            }
            i++;
            continue;
        }

        if (blockCommentLevel !== null) {
            const close = ']' + '='.repeat(blockCommentLevel) + ']';
            if (source.startsWith(close, i)) {
                i += close.length;
                blockCommentLevel = null;
            } else {
                i++;
            }
            continue;
        }

        if (longLevel !== null) {
            const close = ']' + '='.repeat(longLevel) + ']';
            if (source.startsWith(close, i)) {
                output += close;
                i += close.length;
                longLevel = null;
            } else {
                output += c;
                i++;
            }
            continue;
        }

        if (quote) {
            output += c;
            if (c === '\\' && i + 1 < source.length) {
                output += source[i + 1];
                i += 2;
                continue;
            }
            if (c === quote) quote = null;
            i++;
            continue;
        }

        if (c === '-' && next === '-') {
            const opener = source.slice(i + 2).match(/^\[(=*)\[/);
            if (opener) {
                blockCommentLevel = opener[1].length;
                i += 2 + opener[0].length;
            } else {
                lineComment = true;
                i += 2;
            }
            continue;
        }

        const longString = source.slice(i).match(/^\[(=*)\[/);
        if (longString) {
            if (pendingSpace && output && isWord(output[output.length - 1])) {
                output += ' ';
            }
            pendingSpace = false;
            longLevel = longString[1].length;
            output += longString[0];
            i += longString[0].length;
            continue;
        }

        if (c === '"' || c === "'") {
            if (pendingSpace && output && isWord(output[output.length - 1])) {
                output += ' ';
            }
            pendingSpace = false;
            quote = c;
            output += c;
            i++;
            continue;
        }

        if (/\s/.test(c)) {
            pendingSpace = true;
            i++;
            continue;
        }

        if (pendingSpace && output) {
            const previous = output[output.length - 1];
            if (isWord(previous) && isWord(c)) {
                output += ' ';
            }
        }

        pendingSpace = false;
        output += c;
        i++;
    }

    return output.trim();
}

module.exports = { minifyLuau };
