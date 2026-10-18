"use strict";

const { randomInt } = require("node:crypto");
const {
    collectIdentifierNames,
    hasPosition,
    isRecord,
    makeIdentifier,
    makeNumber,
    positionOf,
    uniqueIdentifier,
} = require("./ast-utils");

const utf8 = new TextEncoder();

function pushUtf8(bytes, value) {
    bytes.push(...utf8.encode(value));
}

function parseQuotedString(raw) {
    const quote = raw[0];

    if ((quote !== "'" && quote !== '"') || raw.at(-1) !== quote) {
        throw new Error("Unsupported Luau string literal.");
    }

    const bytes = [];
    let decoded = "";
    let i = 1;
    const end = raw.length - 1;

    while (i < end) {
        const char = raw[i++];

        if (char !== "\\") {
            const codePoint = char.codePointAt(0);
            const value = String.fromCodePoint(codePoint);
            if (codePoint > 0xffff) i++;

            decoded += value;
            pushUtf8(bytes, value);
            continue;
        }

        if (i >= end) {
            throw new Error("Incomplete escape in Luau string.");
        }

        const escape = raw[i++];
        const simpleEscapes = {
            a: 7,
            b: 8,
            f: 12,
            n: 10,
            r: 13,
            t: 9,
            v: 11,
            "\\": 92,
            '"': 34,
            "'": 39,
            "`": 96,
        };

        if (Object.hasOwn(simpleEscapes, escape)) {
            const byte = simpleEscapes[escape];
            bytes.push(byte);
            decoded += String.fromCharCode(byte);
            continue;
        }

        if (escape === "x") {
            const digits = raw.slice(i, i + 2);

            if (!/^[\da-fA-F]{2}$/.test(digits)) {
                throw new Error("Invalid hexadecimal escape in Luau string.");
            }

            const byte = Number.parseInt(digits, 16);
            bytes.push(byte);
            decoded += String.fromCharCode(byte);
            i += 2;
            continue;
        }

        if (/[0-9]/.test(escape)) {
            let digits = escape;

            while (digits.length < 3 && i < end && /[0-9]/.test(raw[i])) {
                digits += raw[i++];
            }

            const byte = Number.parseInt(digits, 10);

            if (byte > 255) {
                throw new Error("Decimal string escape exceeds 255.");
            }

            bytes.push(byte);
            decoded += String.fromCharCode(byte);
            continue;
        }

        if (escape === "z") {
            while (i < end && /\s/.test(raw[i])) i++;
            continue;
        }

        if (escape === "\n") {
            bytes.push(10);
            decoded += "\n";
            continue;
        }

        if (escape === "\r") {
            if (raw[i] === "\n") i++;
            bytes.push(10);
            decoded += "\n";
            continue;
        }

        decoded += escape;
        pushUtf8(bytes, escape);
    }

    return { bytes, decoded };
}

function getStringBytes(literal) {
    const raw = literal.raw;
    let parsed;

    if (/^\[(=*)\[/.test(raw)) {
        parsed = {
            bytes: Array.from(utf8.encode(literal.value)),
            decoded: literal.value,
        };
    } else {
        parsed = parseQuotedString(raw);
    }

    if (parsed.decoded !== literal.value) {
        throw new Error(
            "This string escape is not supported for strong string encoding. Use standard mode for this source.",
        );
    }

    return parsed.bytes;
}

function calculatePayloadCheck(bytes, key, stride) {
    let check = 0;

    for (let index = 0; index < bytes.length; index++) {
        check = (
            check * 33 +
            bytes[index] +
            key +
            (index + 1) * stride
        ) % 2147483647;
    }

    return check;
}

function makeEncodedByteCall(plainBytes, position, decoderName) {
    const key = randomInt(1, 256);
    const stride = randomInt(1, 256);
    const bytes = plainBytes.map(
        (byte, index) => byte ^ ((key + (index + 1) * stride) % 256),
    );
    const payloadCheck = calculatePayloadCheck(bytes, key, stride);

    const byteTable = {
        type: "TableExpression",
        fields: bytes.map((value) => ({
            type: "TableFieldPositional",
            value: makeNumber(value, position),
        })),
        line: { ...position.line },
        column: { ...position.column },
    };

    return {
        type: "CallExpression",
        callee: makeIdentifier(decoderName, position),
        arguments: [
            byteTable,
            makeNumber(key, position),
            makeNumber(stride, position),
            makeNumber(payloadCheck, position),
        ],
        line: { ...position.line },
        column: { ...position.column },
    };
}

function makeEncodedStringCall(literal, decoderName) {
    return makeEncodedByteCall(
        getStringBytes(literal),
        positionOf(literal),
        decoderName,
    );
}

function makeEncodedNameCall(name, position, decoderName) {
    return makeEncodedByteCall(
        Array.from(utf8.encode(name)),
        position,
        decoderName,
    );
}

function makeEncodedPropertyAccess(object, propertyName, position, decoderName) {
    return {
        type: "IndexExpression",
        object,
        index: makeEncodedNameCall(propertyName, position, decoderName),
        line: { ...position.line },
        column: { ...position.column },
    };
}

function makeEncodedFunctionTarget(target, base, decoderName, onEncoded) {
    let expression = base;

    for (const pathPart of target.path) {
        onEncoded();
        expression = makeEncodedPropertyAccess(
            expression,
            pathPart.name,
            positionOf(pathPart),
            decoderName,
        );
    }

    if (target.method) {
        onEncoded();
        expression = makeEncodedPropertyAccess(
            expression,
            target.method.name,
            positionOf(target.method),
            decoderName,
        );
    }

    return expression;
}

function makeEncodedMethodCall(node, args, decoderName) {
    const receiver = node.object;
    const receiverPosition = positionOf(receiver);
    const receiverForLookup = makeIdentifier(receiver.name, receiverPosition);
    const receiverForCall = makeIdentifier(receiver.name, receiverPosition);
    const position = positionOf(node);

    return {
        type: "CallExpression",
        callee: makeEncodedPropertyAccess(
            receiverForLookup,
            node.method.name,
            positionOf(node.method),
            decoderName,
        ),
        arguments: [receiverForCall, ...args],
        line: { ...position.line },
        column: { ...position.column },
    };
}

function isTypeSyntaxNode(value) {
    if (typeof value.type !== "string") return false;

    return (
        value.type.endsWith("TypeNode") ||
        value.type.startsWith("TypeLiteral") ||
        value.type === "TypeReference" ||
        value.type === "TypePackNode" ||
        value.type === "GenericTypeParameter" ||
        value.type === "FunctionTypeParameter" ||
        value.type === "TableTypeProperty"
    );
}

function encodeStrong(program, source) {
    const usedNames = collectIdentifierNames(program);
    const decoderName = uniqueIdentifier(source, usedNames);
    let encodedStrings = 0;
    let encodedProperties = 0;

    function rewriteFunctionDeclaration(value) {
        const target = value.target;

        if (target.path.length === 0 && !target.method) {
            value.func = rewrite(value.func);
            return value;
        }

        const base = rewrite(target.base);
        const rewrittenTarget = makeEncodedFunctionTarget(
            target,
            base,
            decoderName,
            () => encodedProperties++,
        );
        const functionBody = rewrite(value.func);
        const functionExpression = {
            type: "FunctionExpression",
            func: functionBody,
            line: { ...functionBody.line },
            column: { ...functionBody.column },
        };

        return {
            type: "AssignmentStatement",
            targets: [rewrittenTarget],
            values: [functionExpression],
            line: { ...value.line },
            column: { ...value.column },
        };
    }

    function rewrite(value) {
        if (Array.isArray(value)) return value.map(rewrite);
        if (!isRecord(value)) return value;
        if (isTypeSyntaxNode(value)) return value;

        if (
            value.type === "FunctionDeclarationStatement" &&
            isRecord(value.target) &&
            isRecord(value.func) &&
            hasPosition(value)
        ) {
            return rewriteFunctionDeclaration(value);
        }

        if (
            value.type === "StringLiteral" &&
            typeof value.value === "string" &&
            typeof value.raw === "string" &&
            hasPosition(value)
        ) {
            encodedStrings++;
            return makeEncodedStringCall(value, decoderName);
        }

        if (
            value.type === "MemberExpression" &&
            isRecord(value.object) &&
            isRecord(value.property) &&
            typeof value.property.name === "string" &&
            hasPosition(value)
        ) {
            const node = value;
            encodedProperties++;
            return makeEncodedPropertyAccess(
                rewrite(node.object),
                node.property.name,
                positionOf(node),
                decoderName,
            );
        }

        if (
            value.type === "MethodCallExpression" &&
            isRecord(value.object) &&
            isRecord(value.method) &&
            typeof value.method.name === "string" &&
            Array.isArray(value.arguments) &&
            hasPosition(value)
        ) {
            const node = value;
            const args = node.arguments.map(rewrite);

            if (node.object.type === "Identifier") {
                encodedProperties++;
                return makeEncodedMethodCall(node, args, decoderName);
            }

            node.object = rewrite(node.object);
            node.arguments = args;
            return node;
        }

        if (
            value.type === "TableFieldNamed" &&
            isRecord(value.name) &&
            value.name.type === "Identifier" &&
            typeof value.name.name === "string" &&
            isRecord(value.value)
        ) {
            encodedProperties++;

            return {
                type: "TableFieldComputed",
                key: makeEncodedNameCall(
                    value.name.name,
                    positionOf(value.name),
                    decoderName,
                ),
                value: rewrite(value.value),
            };
        }

        for (const [key, child] of Object.entries(value)) {
            if (key !== "line" && key !== "column") {
                value[key] = rewrite(child);
            }
        }

        return value;
    }

    rewrite(program);

    return {
        encodedStrings,
        encodedProperties,
        decoderName,
    };
}

function createDecoderSource(name, source, program) {
    const usedNames = collectIdentifierNames(program);
    const charName = uniqueIdentifier(source, usedNames);
    const xorName = uniqueIdentifier(source, usedNames);
    const concatName = uniqueIdentifier(source, usedNames);
    const createName = uniqueIdentifier(source, usedNames);
    const errorName = uniqueIdentifier(source, usedNames);
    const dataName = uniqueIdentifier(source, usedNames);
    const keyName = uniqueIdentifier(source, usedNames);
    const strideName = uniqueIdentifier(source, usedNames);
    const checkName = uniqueIdentifier(source, usedNames);
    const resultName = uniqueIdentifier(source, usedNames);
    const indexName = uniqueIdentifier(source, usedNames);
    const checksumName = uniqueIdentifier(source, usedNames);

    return `local ${charName} = string.char
local ${xorName} = bit32.bxor
local ${concatName} = table.concat
local ${createName} = table.create
local ${errorName} = error
local function ${name}(${dataName}: {number}, ${keyName}: number, ${strideName}: number, ${checkName}: number): string
    local ${resultName}: {string} = ${createName}(#${dataName})
    local ${checksumName} = 0
    for ${indexName} = 1, #${dataName} do
        ${checksumName} = (${checksumName} * 33 + ${dataName}[${indexName}] + ${keyName} + ${indexName} * ${strideName}) % 2147483647
        ${resultName}[${indexName}] = ${charName}(${xorName}(${dataName}[${indexName}], (${keyName} + ${indexName} * ${strideName}) % 256))
    end
    if ${checksumName} ~= ${checkName} then
        ${errorName}("Tampering detected: encoded payload changed", 0)
    end
    return ${concatName}(${resultName})
end
`;
}

function extractLeadingDirectives(source) {
    const directives = [];

    for (const line of source.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        if (!trimmed.startsWith("--")) break;
        if (trimmed.startsWith("--!")) directives.push(trimmed);
    }

    return directives;
}

module.exports = {
    createDecoderSource,
    encodeStrong,
    extractLeadingDirectives,
};
