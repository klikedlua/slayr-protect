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

function makeBinary(operator, left, right, position) {
    return {
        type: "BinaryExpression",
        operator,
        left,
        right,
        line: { ...position.line },
        column: { ...position.column },
    };
}

function makeReference(name, position) {
    return makeIdentifier(name, position);
}

function makeOpaquePredicate(names, shape, position) {
    const [a, b, c] = names.map((name) => makeReference(name, position));

    switch (shape) {
        case 0:
            return makeBinary(
                "==",
                makeBinary("+", a, b, position),
                makeBinary(
                    "+",
                    makeReference(names[1], position),
                    makeReference(names[0], position),
                    position,
                ),
                position,
            );
        case 1:
            return makeBinary(
                "==",
                makeBinary(
                    "*",
                    makeBinary(
                        "+",
                        makeReference(names[0], position),
                        makeReference(names[1], position),
                        position,
                    ),
                    c,
                    position,
                ),
                makeBinary(
                    "+",
                    makeBinary(
                        "*",
                        makeReference(names[0], position),
                        makeReference(names[2], position),
                        position,
                    ),
                    makeBinary(
                        "*",
                        makeReference(names[1], position),
                        makeReference(names[2], position),
                        position,
                    ),
                    position,
                ),
                position,
            );
        case 2:
            return makeBinary(
                "==",
                makeBinary(
                    "*",
                    makeBinary(
                        "*",
                        makeReference(names[0], position),
                        makeReference(names[1], position),
                        position,
                    ),
                    makeReference(names[2], position),
                    position,
                ),
                makeBinary(
                    "*",
                    makeReference(names[0], position),
                    makeBinary(
                        "*",
                        makeReference(names[1], position),
                        makeReference(names[2], position),
                        position,
                    ),
                    position,
                ),
                position,
            );
        default:
            return makeBinary(
                "==",
                makeBinary(
                    "+",
                    makeBinary(
                        "-",
                        makeReference(names[0], position),
                        makeReference(names[1], position),
                        position,
                    ),
                    makeReference(names[2], position),
                    position,
                ),
                makeBinary(
                    "+",
                    makeReference(names[0], position),
                    makeBinary(
                        "-",
                        makeReference(names[2], position),
                        makeReference(names[1], position),
                        position,
                    ),
                    position,
                ),
                position,
            );
    }
}

function wrapCondition(condition, names, index) {
    if (!isRecord(condition) || !hasPosition(condition)) return condition;

    const position = positionOf(condition);
    const predicate = makeOpaquePredicate(
        names,
        index % 4,
        position,
    );

    return makeBinary("and", predicate, condition, position);
}

function makeLocal(name, value, position) {
    const localPosition = {
        line: { ...position.line },
        column: { ...position.column },
    };

    return {
        type: "LocalStatement",
        names: [{
            type: "TypedIdentifier",
            name,
            typeAnnotation: undefined,
            attributes: undefined,
            line: { ...position.line },
            column: { ...position.column },
        }],
        init: [makeNumber(value, position)],
        ...localPosition,
    };
}

function scrambleControlFlow(program, source) {
    const usedNames = collectIdentifierNames(program);
    const names = [
        uniqueIdentifier(source, usedNames),
        uniqueIdentifier(source, usedNames),
        uniqueIdentifier(source, usedNames),
    ];
    const values = [
        randomInt(3, 23),
        randomInt(3, 23),
        randomInt(3, 23),
    ];
    let scrambledConditions = 0;

    function wrap(condition) {
        const result = wrapCondition(
            condition,
            names,
            randomInt(0, 4),
        );
        if (result !== condition) scrambledConditions++;
        return result;
    }

    function visit(value) {
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                value[index] = visit(value[index]);
            }
            return value;
        }

        if (!isRecord(value)) return value;

        for (const [key, child] of Object.entries(value)) {
            if (key !== "line" && key !== "column") {
                value[key] = visit(child);
            }
        }

        if (
            (value.type === "IfStatement" ||
                value.type === "IfElseExpression") &&
            Array.isArray(value.clauses)
        ) {
            for (const clause of value.clauses) {
                if (isRecord(clause) && isRecord(clause.condition)) {
                    clause.condition = wrap(clause.condition);
                }
            }
        } else if (
            (value.type === "WhileStatement" ||
                value.type === "RepeatStatement") &&
            isRecord(value.condition)
        ) {
            value.condition = wrap(value.condition);
        }

        return value;
    }

    visit(program);

    if (scrambledConditions > 0) {
        const position = positionOf(program);
        program.body.statements.unshift(
            makeLocal(names[0], values[0], position),
            makeLocal(names[1], values[1], position),
            makeLocal(names[2], values[2], position),
        );
    }

    return { scrambledConditions };
}

module.exports = { scrambleControlFlow };
