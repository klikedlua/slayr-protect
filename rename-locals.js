"use strict";

const { analyzeScopes } = require("luau-parser");
const {
    collectIdentifierNames,
    uniqueIdentifier,
} = require("./ast-utils");

/**
 * Rename local declarations and their resolved references together.
 * Globals and Luau's implicit method `self` binding are left intact.
 */
function renameLocalBindings(program, source) {
    const analysis = analyzeScopes(program);
    const usedNames = collectIdentifierNames(program);
    let renamed = 0;

    for (const binding of analysis.bindings.values()) {
        if (
            binding.kind === "global" ||
            binding.kind === "self" ||
            !binding.declarationNode
        ) {
            continue;
        }

        const replacement = uniqueIdentifier(source, usedNames);
        binding.declarationNode.name = replacement;

        for (const reference of binding.references) {
            reference.name = replacement;
        }

        renamed++;
    }

    return renamed;
}

module.exports = { renameLocalBindings };
