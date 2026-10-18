"use strict";

const { randomBytes } = require("node:crypto");

function isRecord(value) {
    return typeof value === "object" && value !== null;
}

function hasPosition(value) {
    return (
        isRecord(value.line) &&
        isRecord(value.column) &&
        typeof value.line.start === "number" &&
        typeof value.line.end === "number" &&
        typeof value.column.start === "number" &&
        typeof value.column.end === "number"
    );
}

function uniqueIdentifier(source, usedNames) {
    const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

    for (;;) {
        const length = 8 + (randomBytes(1)[0] % 13);
        const candidate = Array.from(
            randomBytes(length),
            (byte) => alphabet[byte % alphabet.length],
        ).join("");

        if (!usedNames.has(candidate) && !source.includes(candidate)) {
            usedNames.add(candidate);
            return candidate;
        }
    }
}

function collectIdentifierNames(program) {
    const names = new Set();

    function visit(value) {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }

        if (!isRecord(value)) return;

        if (
            (value.type === "Identifier" ||
                value.type === "TypedIdentifier" ||
                value.type === "FunctionParameter") &&
            typeof value.name === "string"
        ) {
            names.add(value.name);
        }

        for (const [key, child] of Object.entries(value)) {
            if (key !== "line" && key !== "column") visit(child);
        }
    }

    visit(program);
    return names;
}

function positionOf(node) {
    return {
        line: { ...node.line },
        column: { ...node.column },
    };
}

function makeIdentifier(name, position) {
    return {
        type: "Identifier",
        name,
        line: { ...position.line },
        column: { ...position.column },
    };
}

function makeNumber(value, position) {
    return {
        type: "NumberLiteral",
        value,
        raw: String(value),
        line: { ...position.line },
        column: { ...position.column },
    };
}

module.exports = {
    collectIdentifierNames,
    hasPosition,
    isRecord,
    makeIdentifier,
    makeNumber,
    positionOf,
    uniqueIdentifier,
};
