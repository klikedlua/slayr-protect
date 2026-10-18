"use strict";

const crypto = require("node:crypto");

const UINT32 = 0x100000000;
const CHECKSUM_MODULUS = 2147483647;
const MAX_INSTRUCTIONS_PER_FUNCTION = 100000;
const MAX_TOTAL_INSTRUCTIONS = 200000;
const MAX_REGISTERS_PER_FUNCTION = 8192;
const MAX_FUNCTIONS = 1024;
const MAX_CONSTANTS = 50000;

const OPCODES = [
    "LOADK", "LOADNIL", "MOVE", "RESETREG",
    "GETGLOBAL", "SETGLOBAL", "GETUPVAL", "SETUPVAL",
    "GETTABLE", "GETTABLEK", "SETTABLE", "SETTABLEK", "SETLIST",
    "NEWTABLE", "CLOSURE", "CALL", "RETURN",
    "GETVARARG", "GETMULTI", "FIRST",
    "JMP", "JMPFALSE", "JMPTRUE", "CHECKITER",
    "ADD", "SUB", "MUL", "DIV", "IDIV", "MOD", "POW", "CONCAT",
    "EQ", "NE", "LT", "LE", "GT", "GE",
    "BAND", "BOR", "BXOR", "SHL", "SHR",
    "UNM", "NOT", "LEN", "BNOT"
];

const BINARY_OPCODES = new Map([
    ["+", "ADD"], ["-", "SUB"], ["*", "MUL"], ["/", "DIV"],
    ["//", "IDIV"], ["%", "MOD"], ["^", "POW"], ["..", "CONCAT"],
    ["==", "EQ"], ["~=", "NE"], ["!=", "NE"], ["<", "LT"],
    ["<=", "LE"], [">", "GT"], [">=", "GE"],
    ["&", "BAND"], ["|", "BOR"], ["~", "BXOR"],
    ["<<", "SHL"], [">>", "SHR"]
]);

const COMPOUND_OPS = new Map([
    ["+=", "ADD"], ["-=", "SUB"], ["*=", "MUL"], ["/=", "DIV"],
    ["//=", "IDIV"], ["%=", "MOD"], ["^=", "POW"], ["..=", "CONCAT"],
    ["&=", "BAND"], ["|=", "BOR"]
]);

function randomUInt32() {
    return crypto.randomBytes(4).readUInt32LE(0);
}

function randomIdentifier() {
    return `_${crypto.randomBytes(5).toString("hex")}`;
}

function getName(node) {
    if (typeof node === "string") return node;
    if (node && typeof node.name === "string") return node.name;
    return null;
}

function lineSuffix(node) {
    const line = node && node.line && node.line.start;
    return Number.isInteger(line) ? ` at line ${line}` : "";
}

function unsupported(node, detail) {
    const what = detail || (node && node.type) || "syntax";
    throw new Error(
        `VM profile does not support ${what} yet${lineSuffix(node)}. ` +
        "Use Standard or Strong for this script."
    );
}

class VmBuilder {
    constructor() {
        this.constants = [];
        this.constantIndices = new Map();
        this.prototypes = [];
    }

    constant(kind, value) {
        let key;
        if (kind === "string") {
            key = `s:${value}`;
        } else if (kind === "number") {
            key = `n:${String(value)}`;
        } else if (kind === "boolean") {
            key = `b:${value ? 1 : 0}`;
        } else {
            key = "nil";
        }

        const existing = this.constantIndices.get(key);
        if (existing !== undefined) return existing;
        if (this.constants.length >= MAX_CONSTANTS) {
            throw new Error("VM profile reached its constant limit.");
        }

        const index = this.constants.length + 1;
        this.constantIndices.set(key, index);
        this.constants.push({ kind, value });
        return index;
    }

    addFunction(body, parentCompiler = null) {
        if (this.prototypes.length >= MAX_FUNCTIONS) {
            throw new Error("VM profile reached its function limit.");
        }

        const index = this.prototypes.length + 1;
        this.prototypes.push(null);

        const compiler = new FunctionCompiler(this, parentCompiler, body);
        compiler.compileStatements(body.body.statements, false);
        compiler.emit("RETURN", 1, 0, 0);
        this.prototypes[index - 1] = compiler.finish();
        return index;
    }

    addMain(block) {
        return this.addFunction({
            params: [],
            hasVarargs: false,
            body: block,
            generics: []
        });
    }
}

class FunctionCompiler {
    constructor(builder, parent, body) {
        this.builder = builder;
        this.parent = parent;
        this.body = body;
        this.instructions = [];
        this.scopes = [new Map()];
        this.upvalues = [];
        this.upvalueIndices = new Map();
        this.loopStack = [];
        this.registerCount = 0;
        this.parameterCount = 0;

        const params = Array.isArray(body.params) ? body.params : [];
        for (const parameter of params) {
            if (parameter.defaultValue || parameter.default ||
                parameter.value !== undefined) {
                unsupported(parameter, "default function parameters");
            }
            const name = getName(parameter.name);
            if (!name) unsupported(parameter, "function parameter");
            this.declareLocal(name);
            this.parameterCount++;
        }
    }

    finish() {
        return {
            code: this.instructions,
            registers: this.registerCount,
            params: this.parameterCount,
            hasVarargs: Boolean(this.body.hasVarargs),
            upvalues: this.upvalues
        };
    }

    emit(op, a = 0, b = 0, c = 0) {
        if (this.instructions.length >= MAX_INSTRUCTIONS_PER_FUNCTION) {
            throw new Error("VM profile reached its instruction limit.");
        }
        this.instructions.push({ op, a, b, c });
        return this.instructions.length - 1;
    }

    patch(instructionIndex, field, value) {
        this.instructions[instructionIndex][field] = value;
    }

    allocate(count = 1) {
        const first = this.registerCount + 1;
        this.registerCount += count;
        if (this.registerCount > MAX_REGISTERS_PER_FUNCTION) {
            throw new Error("VM profile reached its register limit.");
        }
        return first;
    }

    enterScope() {
        this.scopes.push(new Map());
    }

    leaveScope() {
        this.scopes.pop();
    }

    declareLocal(name) {
        const scope = this.scopes[this.scopes.length - 1];
        const register = this.allocate();
        scope.set(name, register);
        return register;
    }

    findLocal(name) {
        for (let index = this.scopes.length - 1; index >= 0; index--) {
            const register = this.scopes[index].get(name);
            if (register !== undefined) {
                return { kind: "local", index: register };
            }
        }
        return null;
    }

    resolve(name) {
        const local = this.findLocal(name);
        if (local) return local;
        if (!this.parent) return { kind: "global", name };

        const outer = this.parent.resolve(name);
        if (outer.kind === "global") return outer;

        const key = `${outer.kind}:${outer.index}`;
        let index = this.upvalueIndices.get(key);
        if (index === undefined) {
            index = this.upvalues.length + 1;
            this.upvalueIndices.set(key, index);
            this.upvalues.push([
                outer.kind === "local" ? 0 : 1,
                outer.index
            ]);
        }
        return { kind: "upvalue", index };
    }

    emitRead(reference, destination) {
        if (reference.kind === "local") {
            this.emit("MOVE", destination, reference.index);
        } else if (reference.kind === "upvalue") {
            this.emit("GETUPVAL", destination, reference.index);
        } else {
            this.emit(
                "GETGLOBAL",
                destination,
                this.builder.constant("string", reference.name)
            );
        }
    }

    emitWrite(reference, source) {
        if (reference.kind === "local") {
            this.emit("MOVE", reference.index, source);
        } else if (reference.kind === "upvalue") {
            this.emit("SETUPVAL", source, reference.index);
        } else {
            this.emit(
                "SETGLOBAL",
                source,
                this.builder.constant("string", reference.name)
            );
        }
    }

    compileStatements(statements, makeScope = true) {
        if (makeScope) this.enterScope();
        for (const statement of statements || []) {
            this.compileStatement(statement);
        }
        if (makeScope) this.leaveScope();
    }

    compileBlock(block) {
        if (!block || block.type !== "Block") {
            unsupported(block, "block");
        }
        this.compileStatements(block.statements, true);
    }

    compileStatement(statement) {
        switch (statement.type) {
            case "LocalStatement":
                return this.compileLocalStatement(statement);
            case "LocalFunctionStatement":
                return this.compileLocalFunction(statement);
            case "FunctionDeclarationStatement":
                return this.compileFunctionDeclaration(statement);
            case "AssignmentStatement":
                return this.compileAssignment(statement);
            case "CompoundAssignmentStatement":
                return this.compileCompoundAssignment(statement);
            case "CallStatement":
                this.compileCall(statement.expression, false);
                return;
            case "ReturnStatement":
                return this.compileReturn(statement);
            case "IfStatement":
                return this.compileIfStatement(statement);
            case "WhileStatement":
                return this.compileWhile(statement);
            case "RepeatStatement":
                return this.compileRepeat(statement);
            case "NumericForStatement":
                return this.compileNumericFor(statement);
            case "GenericForStatement":
                return this.compileGenericFor(statement);
            case "BreakStatement":
                return this.compileLoopControl(statement, "break");
            case "ContinueStatement":
                return this.compileLoopControl(statement, "continue");
            case "DoStatement":
                return this.compileBlock(statement.body);
            case "TypeAliasStatement":
            case "ExportTypeAliasStatement":
                return;
            default:
                unsupported(statement);
        }
    }

    compileLocalStatement(statement) {
        const values = this.compileExpressionList(statement.init || []);
        const names = statement.names || [];
        const registers = names.map(name => {
            const identifier = getName(name);
            if (!identifier) unsupported(name, "local declaration");
            return this.declareLocal(identifier);
        });

        for (const register of registers) {
            this.emit("RESETREG", register);
        }
        this.assignValues(registers, values);
    }

    compileLocalFunction(statement) {
        const name = getName(statement.name);
        if (!name) unsupported(statement, "local function declaration");

        const register = this.declareLocal(name);
        this.emit("RESETREG", register);
        const closure = this.compileFunctionBody(statement.func);
        this.emit("MOVE", register, closure);
    }

    compileFunctionDeclaration(statement) {
        const target = statement.target;
        if (!target || target.type !== "FunctionName") {
            unsupported(target, "function declaration target");
        }
        const closure = this.compileFunctionBody(statement.func);
        const path = (target.path || []).map(getName);
        const method = getName(target.method);

        if (path.some(name => !name)) {
            unsupported(target, "function declaration path");
        }
        if (path.length === 0 && !method) {
            this.emitWrite(
                this.resolve(getName(target.base)),
                closure
            );
            return;
        }

        let object = this.compileIdentifierOrExpression(target.base);
        const parts = method ? [...path, method] : path;
        for (let index = 0; index < parts.length - 1; index++) {
            const next = this.allocate();
            this.emit(
                "GETTABLEK",
                next,
                object,
                this.builder.constant("string", parts[index])
            );
            object = next;
        }
        this.emit(
            "SETTABLEK",
            object,
            closure,
            this.builder.constant("string", parts[parts.length - 1])
        );
    }

    compileIdentifierOrExpression(node) {
        if (node && node.type === "Identifier") {
            const destination = this.allocate();
            this.emitRead(this.resolve(node.name), destination);
            return destination;
        }
        return this.compileExpression(node);
    }

    compileAssignment(statement) {
        const targets = (statement.targets || []).map(target =>
            this.prepareTarget(target)
        );
        const values = this.compileExpressionList(statement.values || []);
        const destinations = targets.map(() => this.allocate());
        this.assignValues(destinations, values);
        targets.forEach((target, index) => {
            this.writeTarget(target, destinations[index]);
        });
    }

    compileCompoundAssignment(statement) {
        const opcode = COMPOUND_OPS.get(statement.operator);
        if (!opcode) unsupported(statement, "compound assignment operator");

        const target = this.prepareTarget(statement.target);
        const oldValue = this.allocate();
        this.readTarget(target, oldValue);
        const rightValue = this.compileExpression(statement.value);
        const result = this.allocate();
        this.emit(opcode, result, oldValue, rightValue);
        this.writeTarget(target, result);
    }

    prepareTarget(node) {
        if (!node) unsupported(node, "assignment target");
        if (node.type === "Identifier") {
            return { kind: "variable", reference: this.resolve(node.name) };
        }
        if (node.type === "MemberExpression") {
            return {
                kind: "constantProperty",
                object: this.compileExpression(node.object),
                key: this.builder.constant(
                    "string",
                    getName(node.property)
                )
            };
        }
        if (node.type === "IndexExpression") {
            return {
                kind: "indexed",
                object: this.compileExpression(node.object),
                key: this.compileExpression(node.index)
            };
        }
        unsupported(node, "assignment target");
    }

    readTarget(target, destination) {
        if (target.kind === "variable") {
            this.emitRead(target.reference, destination);
        } else if (target.kind === "constantProperty") {
            this.emit("GETTABLEK", destination, target.object, target.key);
        } else {
            this.emit("GETTABLE", destination, target.object, target.key);
        }
    }

    writeTarget(target, source) {
        if (target.kind === "variable") {
            this.emitWrite(target.reference, source);
        } else if (target.kind === "constantProperty") {
            this.emit("SETTABLEK", target.object, source, target.key);
        } else {
            this.emit("SETTABLE", target.object, target.key, source);
        }
    }

    assignValues(destinations, values) {
        for (let index = 0; index < destinations.length; index++) {
            const destination = destinations[index];
            if (index < values.registers.length - 1) {
                this.emit("MOVE", destination, values.registers[index]);
                continue;
            }

            if (values.registers.length > 0 &&
                index === values.registers.length - 1 &&
                !values.lastMulti) {
                this.emit("MOVE", destination, values.registers[index]);
                continue;
            }

            if (values.lastMulti && values.registers.length > 0) {
                const multiOffset = index - values.registers.length + 2;
                this.emit(
                    "GETMULTI",
                    destination,
                    values.registers[values.registers.length - 1],
                    multiOffset
                );
                continue;
            }

            this.emit("LOADNIL", destination);
        }
    }

    compileExpressionList(expressions) {
        const registers = [];
        const items = expressions || [];
        for (let index = 0; index < items.length; index++) {
            const keepMulti = index === items.length - 1 &&
                this.canReturnMultiple(items[index]);
            registers.push(
                this.compileExpression(items[index], keepMulti)
            );
        }
        return {
            registers,
            lastMulti: items.length > 0 &&
                this.canReturnMultiple(items[items.length - 1])
        };
    }

    canReturnMultiple(node) {
        return Boolean(node && (
            node.type === "CallExpression" ||
            node.type === "MethodCallExpression" ||
            node.type === "VarargExpression"
        ));
    }

    compileReturn(statement) {
        const values = this.compileExpressionList(statement.arguments || []);
        const first = this.allocate(Math.max(1, values.registers.length));
        values.registers.forEach((register, index) => {
            this.emit("MOVE", first + index, register);
        });
        this.emit("RETURN", first, values.registers.length, 0);
    }

    compileIfStatement(statement) {
        const exitJumps = [];
        for (const clause of statement.clauses || []) {
            const condition = this.compileExpression(clause.condition);
            const skip = this.emit("JMPFALSE", 0, condition);
            this.compileBlock(clause.body);
            exitJumps.push(this.emit("JMP", 0));
            this.patch(skip, "a", this.instructions.length);
        }

        if (statement.alternate) {
            this.compileBlock(statement.alternate);
        }

        const end = this.instructions.length;
        exitJumps.forEach(index => this.patch(index, "a", end));
    }

    compileWhile(statement) {
        const start = this.instructions.length;
        const condition = this.compileExpression(statement.condition);
        const exit = this.emit("JMPFALSE", 0, condition);
        const loop = {
            breaks: [],
            continues: [],
            continueTarget: start
        };
        this.loopStack.push(loop);
        this.compileBlock(statement.body);
        loop.continues.forEach(index =>
            this.patch(index, "a", loop.continueTarget)
        );
        this.emit("JMP", start);
        const end = this.instructions.length;
        this.patch(exit, "a", end);
        loop.breaks.forEach(index => this.patch(index, "a", end));
        this.loopStack.pop();
    }

    compileRepeat(statement) {
        const start = this.instructions.length;
        const loop = {
            breaks: [],
            continues: [],
            continueTarget: null
        };

        this.enterScope();
        this.loopStack.push(loop);
        this.compileStatements(statement.body.statements, false);
        loop.continueTarget = this.instructions.length;
        loop.continues.forEach(index =>
            this.patch(index, "a", loop.continueTarget)
        );
        const condition = this.compileExpression(statement.condition);
        const back = this.emit("JMPFALSE", start, condition);
        const end = this.instructions.length;
        loop.breaks.forEach(index => this.patch(index, "a", end));
        this.loopStack.pop();
        this.leaveScope();
        return back;
    }

    compileNumericFor(statement) {
        const initialValue = this.compileExpression(statement.start);
        const limitValue = this.compileExpression(statement.end);
        const stepValue = statement.step
            ? this.compileExpression(statement.step)
            : this.loadConstant("number", 1);

        this.enterScope();
        const variableName = getName(statement.variable);
        if (!variableName) unsupported(statement, "numeric for variable");
        const loopVariable = this.declareLocal(variableName);
        const controlVariable = this.allocate();
        this.emit("MOVE", controlVariable, initialValue);

        const loopStart = this.instructions.length;
        const zero = this.loadConstant("number", 0);
        const nonnegative = this.allocate();
        this.emit("GE", nonnegative, stepValue, zero);
        const negativeBranch = this.emit("JMPFALSE", 0, nonnegative);

        const positiveCondition = this.allocate();
        this.emit("LE", positiveCondition, controlVariable, limitValue);
        const positiveExit = this.emit("JMPFALSE", 0, positiveCondition);
        const positiveBody = this.emit("JMP", 0);

        const negativeStart = this.instructions.length;
        this.patch(negativeBranch, "a", negativeStart);
        const negativeCondition = this.allocate();
        this.emit("GE", negativeCondition, controlVariable, limitValue);
        const negativeExit = this.emit("JMPFALSE", 0, negativeCondition);

        const bodyStart = this.instructions.length;
        this.patch(positiveBody, "a", bodyStart);
        const loop = {
            breaks: [],
            continues: [],
            continueTarget: null
        };
        this.loopStack.push(loop);
        this.emit("RESETREG", loopVariable);
        this.emit("MOVE", loopVariable, controlVariable);
        this.compileBlock(statement.body);

        loop.continueTarget = this.instructions.length;
        loop.continues.forEach(index =>
            this.patch(index, "a", loop.continueTarget)
        );
        const nextValue = this.allocate();
        this.emit("ADD", nextValue, controlVariable, stepValue);
        this.emit("MOVE", controlVariable, nextValue);
        this.emit("JMP", loopStart);
        const end = this.instructions.length;
        this.patch(positiveExit, "a", end);
        this.patch(negativeExit, "a", end);
        loop.breaks.forEach(index => this.patch(index, "a", end));
        this.loopStack.pop();
        this.leaveScope();
    }

    compileGenericFor(statement) {
        const iteratorValues = this.compileExpressionList(
            statement.iterators || []
        );
        if (iteratorValues.registers.length === 0) {
            unsupported(statement, "generic for without an iterator");
        }

        this.enterScope();
        const loopVariables = (statement.variables || []).map(variable => {
            const name = getName(variable);
            if (!name) unsupported(variable, "generic for variable");
            return this.declareLocal(name);
        });
        const iterator = this.allocate();
        const state = this.allocate();
        const control = this.allocate();
        this.assignValues(
            [iterator, state, control],
            iteratorValues
        );
        this.emit("CHECKITER", iterator);

        const loop = {
            breaks: [],
            continues: [],
            continueTarget: null
        };
        this.loopStack.push(loop);
        const loopStart = this.instructions.length;
        const callBase = this.allocate(3);
        this.emit("MOVE", callBase, iterator);
        this.emit("MOVE", callBase + 1, state);
        this.emit("MOVE", callBase + 2, control);
        this.emit("CALL", callBase, 2, 0);

        const firstResult = this.allocate();
        this.emit("GETMULTI", firstResult, callBase, 1);
        const nilValue = this.allocate();
        this.emit("LOADNIL", nilValue);
        const isFinished = this.allocate();
        this.emit("EQ", isFinished, firstResult, nilValue);
        const exit = this.emit("JMPTRUE", 0, isFinished);
        this.emit("MOVE", control, firstResult);

        loopVariables.forEach((register, index) => {
            this.emit("RESETREG", register);
            this.emit("GETMULTI", register, callBase, index + 1);
        });
        this.compileBlock(statement.body);

        loop.continueTarget = this.instructions.length;
        loop.continues.forEach(index =>
            this.patch(index, "a", loop.continueTarget)
        );
        this.emit("JMP", loopStart);
        const end = this.instructions.length;
        this.patch(exit, "a", end);
        loop.breaks.forEach(index => this.patch(index, "a", end));
        this.loopStack.pop();
        this.leaveScope();
    }

    compileLoopControl(statement, kind) {
        const loop = this.loopStack[this.loopStack.length - 1];
        if (!loop) unsupported(statement, `${kind} outside a loop`);
        const jump = this.emit("JMP", 0);
        loop[kind === "break" ? "breaks" : "continues"].push(jump);
    }

    compileFunctionBody(body) {
        if (!body || body.type !== "FunctionBody") {
            unsupported(body, "function body");
        }
        const prototype = this.builder.addFunction(body, this);
        const destination = this.allocate();
        this.emit("CLOSURE", destination, prototype);
        return destination;
    }

    compileExpression(node, preserveMultiple = false) {
        if (!node) unsupported(node, "expression");

        switch (node.type) {
            case "Identifier": {
                const destination = this.allocate();
                this.emitRead(this.resolve(node.name), destination);
                return destination;
            }
            case "NumberLiteral": {
                if (!Number.isFinite(node.value)) {
                    unsupported(node, "non-finite numeric literal");
                }
                return this.loadConstant("number", node.value);
            }
            case "StringLiteral":
                return this.loadConstant("string", node.value);
            case "BooleanLiteral":
                return this.loadConstant("boolean", node.value);
            case "NilLiteral": {
                const destination = this.allocate();
                this.emit("LOADNIL", destination);
                return destination;
            }
            case "VarargExpression": {
                if (!this.body.hasVarargs) {
                    unsupported(node, "vararg outside a vararg function");
                }
                const destination = this.allocate();
                this.emit("GETVARARG", destination);
                return preserveMultiple
                    ? destination
                    : this.firstValue(destination);
            }
            case "ParenthesizedExpression":
                return this.compileExpression(node.expression);
            case "BinaryExpression":
                return this.compileBinary(node);
            case "UnaryExpression":
                return this.compileUnary(node);
            case "TableExpression":
                return this.compileTable(node);
            case "MemberExpression":
                return this.compileMember(node);
            case "IndexExpression":
                return this.compileIndex(node);
            case "CallExpression":
                return this.compileCall(node, preserveMultiple);
            case "MethodCallExpression":
                return this.compileMethodCall(node, preserveMultiple);
            case "FunctionExpression":
                return this.compileFunctionBody(node.func);
            case "IfElseExpression":
                return this.compileIfExpression(node);
            default:
                unsupported(node, "expression " + node.type);
        }
    }

    loadConstant(kind, value) {
        const destination = this.allocate();
        this.emit(
            "LOADK",
            destination,
            this.builder.constant(kind, value)
        );
        return destination;
    }

    firstValue(register) {
        const destination = this.allocate();
        this.emit("FIRST", destination, register);
        return destination;
    }

    compileBinary(node) {
        if (node.operator === "and" || node.operator === "or") {
            const left = this.compileExpression(node.left);
            const destination = this.allocate();
            this.emit("MOVE", destination, left);
            const jump = node.operator === "and"
                ? this.emit("JMPFALSE", 0, left)
                : this.emit("JMPTRUE", 0, left);
            const right = this.compileExpression(node.right);
            this.emit("MOVE", destination, right);
            this.patch(jump, "a", this.instructions.length);
            return destination;
        }

        const opcode = BINARY_OPCODES.get(node.operator);
        if (!opcode) unsupported(node, `binary operator ${node.operator}`);
        const left = this.compileExpression(node.left);
        const right = this.compileExpression(node.right);
        const destination = this.allocate();
        this.emit(opcode, destination, left, right);
        return destination;
    }

    compileUnary(node) {
        const source = this.compileExpression(node.argument);
        const destination = this.allocate();
        const opcodes = {
            "-": "UNM",
            "not": "NOT",
            "#": "LEN",
            "~": "BNOT"
        };
        const opcode = opcodes[node.operator];
        if (!opcode) unsupported(node, `unary operator ${node.operator}`);
        this.emit(opcode, destination, source);
        return destination;
    }

    compileTable(node) {
        const tableRegister = this.allocate();
        this.emit("NEWTABLE", tableRegister);
        let arrayIndex = 1;
        const fields = node.fields || [];

        fields.forEach((field, index) => {
            if (field.type === "TableFieldNamed") {
                const value = this.compileExpression(field.value);
                this.emit(
                    "SETTABLEK",
                    tableRegister,
                    value,
                    this.builder.constant(
                        "string",
                        getName(field.name)
                    )
                );
                return;
            }
            if (field.type === "TableFieldComputed") {
                const key = this.compileExpression(field.key);
                const value = this.compileExpression(field.value);
                this.emit("SETTABLE", tableRegister, key, value);
                return;
            }
            if (field.type === "TableFieldPositional") {
                const isLast = index === fields.length - 1;
                const value = this.compileExpression(
                    field.value,
                    isLast && this.canReturnMultiple(field.value)
                );
                this.emit("SETLIST", tableRegister, arrayIndex, value);
                arrayIndex++;
                return;
            }
            unsupported(field, "table field");
        });
        return tableRegister;
    }

    compileMember(node) {
        const object = this.compileExpression(node.object);
        const destination = this.allocate();
        this.emit(
            "GETTABLEK",
            destination,
            object,
            this.builder.constant("string", getName(node.property))
        );
        return destination;
    }

    compileIndex(node) {
        const object = this.compileExpression(node.object);
        const index = this.compileExpression(node.index);
        const destination = this.allocate();
        this.emit("GETTABLE", destination, object, index);
        return destination;
    }

    compileCall(node, preserveMultiple = false) {
        const functionRegister = this.compileExpression(node.callee);
        const args = this.compileExpressionList(node.arguments || []);
        const base = this.allocate(args.registers.length + 1);
        this.emit("MOVE", base, functionRegister);
        args.registers.forEach((register, index) => {
            this.emit("MOVE", base + index + 1, register);
        });
        this.emit("CALL", base, args.registers.length, 0);
        return preserveMultiple ? base : this.firstValue(base);
    }

    compileMethodCall(node, preserveMultiple = false) {
        const object = this.compileExpression(node.object);
        const functionRegister = this.allocate();
        this.emit(
            "GETTABLEK",
            functionRegister,
            object,
            this.builder.constant("string", getName(node.method))
        );
        const args = this.compileExpressionList(node.arguments || []);
        const base = this.allocate(args.registers.length + 2);
        this.emit("MOVE", base, functionRegister);
        this.emit("MOVE", base + 1, object);
        args.registers.forEach((register, index) => {
            this.emit("MOVE", base + index + 2, register);
        });
        this.emit("CALL", base, args.registers.length, 1);
        return preserveMultiple ? base : this.firstValue(base);
    }

    compileIfExpression(node) {
        const destination = this.allocate();
        const exitJumps = [];
        for (const clause of node.clauses || []) {
            const condition = this.compileExpression(clause.condition);
            const skip = this.emit("JMPFALSE", 0, condition);
            const value = this.compileExpression(clause.body);
            this.emit("MOVE", destination, value);
            exitJumps.push(this.emit("JMP", 0));
            this.patch(skip, "a", this.instructions.length);
        }
        if (!node.alternate) unsupported(node, "if-expression without else");
        const alternate = this.compileExpression(node.alternate);
        this.emit("MOVE", destination, alternate);
        const end = this.instructions.length;
        exitJumps.forEach(index => this.patch(index, "a", end));
        return destination;
    }
}

function checksumStep(checksum, value, index) {
    return (
        (checksum * 33 + (value % 65521) + index) %
        CHECKSUM_MODULUS
    );
}

function makeConstantData(constants, key, indexSalt, byteSalt) {
    return constants.map((constant, index) => {
        const poolIndex = index + 1;
        let kind;
        let raw;
        if (constant.kind === "string") {
            kind = 1;
            raw = Buffer.from(constant.value, "utf8");
        } else if (constant.kind === "number") {
            kind = 2;
            raw = Buffer.from(String(constant.value), "utf8");
        } else if (constant.kind === "boolean") {
            kind = 3;
            raw = Buffer.from(constant.value ? "1" : "0", "utf8");
        } else {
            kind = 4;
            raw = Buffer.alloc(0);
        }

        const encoded = Array.from(raw, (byte, byteIndex) => {
            const offset = byteIndex + 1;
            const mask = (
                key + poolIndex * indexSalt + offset * byteSalt
            ) & 0xff;
            return byte ^ mask;
        });
        return { kind, bytes: encoded };
    });
}

function serialize(builder) {
    const opcodeValues = new Map();
    const unused = new Set(Array.from({ length: 250 }, (_, i) => i + 1));
    for (const name of OPCODES) {
        const choices = [...unused];
        const value = choices[crypto.randomInt(0, choices.length)];
        unused.delete(value);
        opcodeValues.set(name, value);
    }

    const code = [];
    const prototypes = builder.prototypes.map(prototype => {
        const start = code.length / 4;
        for (const instruction of prototype.code) {
            code.push(
                opcodeValues.get(instruction.op),
                instruction.a,
                instruction.b,
                instruction.c
            );
        }
        return {
            start,
            count: prototype.code.length,
            params: prototype.params,
            registers: prototype.registers,
            hasVarargs: prototype.hasVarargs,
            upvalues: prototype.upvalues
        };
    });

    const totalInstructions = code.length / 4;
    if (totalInstructions > MAX_TOTAL_INSTRUCTIONS) {
        throw new Error("VM profile reached its total instruction limit.");
    }
    const codeKey = randomUInt32();
    let codeSalt = randomUInt32() | 1;
    if (codeSalt < 0) codeSalt += UINT32;
    const encryptedCode = code.map((value, index) => {
        const position = index + 1;
        const mask = (codeKey + position * codeSalt) % UINT32;
        return (value ^ mask) >>> 0;
    });

    const constantKey = crypto.randomInt(1, 256);
    const constantIndexSalt = crypto.randomInt(1, 256);
    const constantByteSalt = crypto.randomInt(1, 256);
    const constantData = makeConstantData(
        builder.constants,
        constantKey,
        constantIndexSalt,
        constantByteSalt
    );

    let checksum = 0;
    let checksumIndex = 0;
    for (const value of encryptedCode) {
        checksumIndex++;
        checksum = checksumStep(checksum, value, checksumIndex);
    }
    for (const entry of constantData) {
        checksumIndex++;
        checksum = checksumStep(checksum, entry.kind, checksumIndex);
        for (const byte of entry.bytes) {
            checksumIndex++;
            checksum = checksumStep(checksum, byte, checksumIndex);
        }
    }

    return {
        opcodeValues,
        encryptedCode,
        codeKey,
        codeSalt,
        constantData,
        constantKey,
        constantIndexSalt,
        constantByteSalt,
        checksum,
        prototypes
    };
}

function buildRuntime(serialized) {
    const names = new Set();
    const id = {};
    const identifiers = [
        "code", "constants", "prototypes", "handlers", "codeKey",
        "codeSalt", "constantKey", "constantIndexSalt",
        "constantByteSalt", "expectedChecksum", "environment",
        "unpackValues", "packValues", "closureMarker", "multiMarker",
        "cellMarker", "readRegister", "writeRegister", "captureRegister",
        "makeMulti", "isMulti", "firstValue", "getConstant",
        "decodeWord", "verifyIntegrity", "execute", "checksum",
        "checksumIndex", "entry", "characters", "raw", "value",
        "mask", "frame", "index", "left", "right", "result",
        "prototype", "upvalues", "descriptor", "functionValue",
        "arguments", "argumentIndex", "argumentValue", "argumentCount",
        "returnValues", "instructionIndex", "wordIndex", "opcode",
        "operandA", "operandB", "operandC", "handler", "instruction",
        "registers", "varargs", "parameterIndex", "closure",
        "currentValue", "keyIndex", "fieldIndex", "tableValue",
        "callable", "args", "argIndex", "output"
    ];
    for (const name of identifiers) {
        let generated;
        do {
            generated = randomIdentifier();
        } while (names.has(generated));
        names.add(generated);
        id[name] = generated;
    }

    const opcodeMap = Object.fromEntries(serialized.opcodeValues);
    const handlerLines = [];
    const op = name => opcodeMap[name];
    const read = id.readRegister;
    const write = id.writeRegister;
    const handlers = id.handlers;
    const frame = id.frame;

    handlerLines.push(
        `${handlers}[${op("LOADK")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, ${id.getConstant}(b)) end`,
        `${handlers}[${op("LOADNIL")}] = function(${frame}, a) ` +
        `${write}(${frame}, a, nil) end`,
        `${handlers}[${op("MOVE")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, ${read}(${frame}, b)) end`,
        `${handlers}[${op("RESETREG")}] = function(${frame}, a) ` +
        `${frame}.r[a] = nil end`,
        `${handlers}[${op("GETGLOBAL")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, ${id.environment}[${id.getConstant}(b)]) end`,
        `${handlers}[${op("SETGLOBAL")}] = function(${frame}, a, b) ` +
        `${id.environment}[${id.getConstant}(b)] = ${read}(${frame}, a) end`,
        `${handlers}[${op("GETUPVAL")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, ${frame}.u[b].v) end`,
        `${handlers}[${op("SETUPVAL")}] = function(${frame}, a, b) ` +
        `${frame}.u[b].v = ${read}(${frame}, a) end`,
        `${handlers}[${op("GETTABLE")}] = function(${frame}, a, b, c) ` +
        `${write}(${frame}, a, ${read}(${frame}, b)[${read}(${frame}, c)]) end`,
        `${handlers}[${op("GETTABLEK")}] = function(${frame}, a, b, c) ` +
        `${write}(${frame}, a, ${read}(${frame}, b)[${id.getConstant}(c)]) end`,
        `${handlers}[${op("SETTABLE")}] = function(${frame}, a, b, c) ` +
        `${read}(${frame}, a)[${read}(${frame}, b)] = ${read}(${frame}, c) end`,
        `${handlers}[${op("SETTABLEK")}] = function(${frame}, a, b, c) ` +
        `${read}(${frame}, a)[${id.getConstant}(c)] = ${read}(${frame}, b) end`,
        `${handlers}[${op("SETLIST")}] = function(${frame}, a, b, c) ` +
        `local ${id.currentValue} = ${read}(${frame}, c); ` +
        `if ${id.isMulti}(${id.currentValue}) then ` +
        `local ${id.output} = ${id.currentValue}.v; ` +
        `for ${id.fieldIndex} = 1, ${id.output}.n do ` +
        `${read}(${frame}, a)[b + ${id.fieldIndex} - 1] = ${id.output}[${id.fieldIndex}] ` +
        `end else ${read}(${frame}, a)[b] = ${id.firstValue}(${id.currentValue}) end end`,
        `${handlers}[${op("NEWTABLE")}] = function(${frame}, a) ` +
        `${write}(${frame}, a, {}) end`
    );

    const binaryExpressions = {
        ADD: `${read}(${frame}, b) + ${read}(${frame}, c)`,
        SUB: `${read}(${frame}, b) - ${read}(${frame}, c)`,
        MUL: `${read}(${frame}, b) * ${read}(${frame}, c)`,
        DIV: `${read}(${frame}, b) / ${read}(${frame}, c)`,
        IDIV: `${read}(${frame}, b) // ${read}(${frame}, c)`,
        MOD: `${read}(${frame}, b) % ${read}(${frame}, c)`,
        POW: `${read}(${frame}, b) ^ ${read}(${frame}, c)`,
        CONCAT: `${read}(${frame}, b) .. ${read}(${frame}, c)`,
        EQ: `${read}(${frame}, b) == ${read}(${frame}, c)`,
        NE: `${read}(${frame}, b) ~= ${read}(${frame}, c)`,
        LT: `${read}(${frame}, b) < ${read}(${frame}, c)`,
        LE: `${read}(${frame}, b) <= ${read}(${frame}, c)`,
        GT: `${read}(${frame}, b) > ${read}(${frame}, c)`,
        GE: `${read}(${frame}, b) >= ${read}(${frame}, c)`,
        BAND: `bit32.band(${read}(${frame}, b), ${read}(${frame}, c))`,
        BOR: `bit32.bor(${read}(${frame}, b), ${read}(${frame}, c))`,
        BXOR: `bit32.bxor(${read}(${frame}, b), ${read}(${frame}, c))`,
        SHL: `bit32.lshift(${read}(${frame}, b), ${read}(${frame}, c))`,
        SHR: `bit32.rshift(${read}(${frame}, b), ${read}(${frame}, c))`
    };
    for (const [name, expression] of Object.entries(binaryExpressions)) {
        handlerLines.push(
            `${handlers}[${op(name)}] = function(${frame}, a, b, c) ` +
            `${write}(${frame}, a, ${expression}) end`
        );
    }

    handlerLines.push(
        `${handlers}[${op("UNM")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, -${read}(${frame}, b)) end`,
        `${handlers}[${op("NOT")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, not ${read}(${frame}, b)) end`,
        `${handlers}[${op("LEN")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, #${read}(${frame}, b)) end`,
        `${handlers}[${op("BNOT")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, bit32.bnot(${read}(${frame}, b))) end`,
        `${handlers}[${op("JMP")}] = function(${frame}, a) ${frame}.pc = a end`,
        `${handlers}[${op("JMPFALSE")}] = function(${frame}, a, b) ` +
        `if not ${read}(${frame}, b) then ${frame}.pc = a end end`,
        `${handlers}[${op("JMPTRUE")}] = function(${frame}, a, b) ` +
        `if ${read}(${frame}, b) then ${frame}.pc = a end end`,
        `${handlers}[${op("CHECKITER")}] = function(${frame}, a) ` +
        `if type(${read}(${frame}, a)) ~= "function" then ` +
        `error("VM profile requires a function iterator", 0) end end`,
        `${handlers}[${op("GETVARARG")}] = function(${frame}, a) ` +
        `${write}(${frame}, a, ${id.makeMulti}(${frame}.v)) end`,
        `${handlers}[${op("GETMULTI")}] = function(${frame}, a, b, c) ` +
        `local ${id.currentValue} = ${read}(${frame}, b); ` +
        `local ${id.output}; if ${id.isMulti}(${id.currentValue}) then ` +
        `${id.output} = ${id.currentValue}.v[c] ` +
        `elseif c == 1 then ${id.output} = ${id.currentValue} end; ` +
        `${write}(${frame}, a, ${id.output}) end`,
        `${handlers}[${op("FIRST")}] = function(${frame}, a, b) ` +
        `${write}(${frame}, a, ${id.firstValue}(${read}(${frame}, b))) end`,
        `${handlers}[${op("CALL")}] = function(${frame}, a, b, c) ` +
        `local ${id.callable} = ${read}(${frame}, a); ` +
        `local ${id.arguments} = { n = 0 }; ` +
        `local ${id.argumentCount} = b + c; ` +
        `for ${id.argIndex} = 1, ${id.argumentCount} do ` +
        `local ${id.argumentValue} = ${read}(${frame}, a + ${id.argIndex}); ` +
        `if ${id.argIndex} == ${id.argumentCount} and ${id.isMulti}(${id.argumentValue}) then ` +
        `local ${id.output} = ${id.argumentValue}.v; ` +
        `for ${id.keyIndex} = 1, ${id.output}.n do ` +
        `${id.arguments}.n = ${id.arguments}.n + 1; ` +
        `${id.arguments}[${id.arguments}.n] = ${id.output}[${id.keyIndex}] end ` +
        `else ${id.arguments}.n = ${id.arguments}.n + 1; ` +
        `${id.arguments}[${id.arguments}.n] = ${id.firstValue}(${id.argumentValue}) end end; ` +
        `local ${id.result} = ${id.packValues}(${id.callable}(` +
        `${id.unpackValues}(${id.arguments}, 1, ${id.arguments}.n))); ` +
        `${write}(${frame}, a, ${id.makeMulti}(${id.result})) end`,
        `${handlers}[${op("RETURN")}] = function(${frame}, a, b) ` +
        `local ${id.returnValues} = { n = 0 }; ` +
        `for ${id.argIndex} = 1, b do ` +
        `local ${id.currentValue} = ${read}(${frame}, a + ${id.argIndex} - 1); ` +
        `if ${id.argIndex} == b and ${id.isMulti}(${id.currentValue}) then ` +
        `local ${id.output} = ${id.currentValue}.v; ` +
        `for ${id.keyIndex} = 1, ${id.output}.n do ` +
        `${id.returnValues}.n = ${id.returnValues}.n + 1; ` +
        `${id.returnValues}[${id.returnValues}.n] = ${id.output}[${id.keyIndex}] end ` +
        `else ${id.returnValues}.n = ${id.returnValues}.n + 1; ` +
        `${id.returnValues}[${id.returnValues}.n] = ${id.firstValue}(${id.currentValue}) end end; ` +
        `${frame}.ret = ${id.returnValues}; ${frame}.done = true end`,
        `${handlers}[${op("CLOSURE")}] = function(${frame}, a, b) ` +
        `local ${id.prototype} = ${id.prototypes}[b]; ` +
        `local ${id.upvalues} = {}; ` +
        `for ${id.keyIndex} = 1, #${id.prototype}.upvalues do ` +
        `local ${id.descriptor} = ${id.prototype}.upvalues[${id.keyIndex}]; ` +
        `if ${id.descriptor}[1] == 0 then ` +
        `${id.upvalues}[${id.keyIndex}] = ${id.captureRegister}(${frame}, ${id.descriptor}[2]) ` +
        `else ${id.upvalues}[${id.keyIndex}] = ${frame}.u[${id.descriptor}[2]] end end; ` +
        `local ${id.closure} = function(...) ` +
        `local ${id.output} = ${id.packValues}(${id.execute}(b, ${id.packValues}(...), ${id.upvalues})); ` +
        `return ${id.unpackValues}(${id.output}, 1, ${id.output}.n) end; ` +
        `${write}(${frame}, a, ${id.closure}) end`
    );

    const opcodeHandlers = handlerLines.join("\n");
    const codeLiteral = `{${serialized.encryptedCode.join(",")}}`;
    const constantsLiteral = `{${serialized.constantData.map(entry =>
        `{${entry.kind},{${entry.bytes.join(",")}}}`
    ).join(",")}}`;
    const prototypesLiteral = `{${serialized.prototypes.map(prototype =>
        `{${prototype.start},${prototype.count},${prototype.params},` +
        `${prototype.registers},${prototype.hasVarargs ? 1 : 0},` +
        `{${prototype.upvalues.map(item => `{${item[0]},${item[1]}}`).join(",")}}}`
    ).join(",")}}`;

    let source = `
local ${id.code} = ${codeLiteral}
local ${id.constants} = ${constantsLiteral}
local ${id.prototypes} = ${prototypesLiteral}
local ${id.codeKey} = ${serialized.codeKey}
local ${id.codeSalt} = ${serialized.codeSalt}
local ${id.constantKey} = ${serialized.constantKey}
local ${id.constantIndexSalt} = ${serialized.constantIndexSalt}
local ${id.constantByteSalt} = ${serialized.constantByteSalt}
local ${id.expectedChecksum} = ${serialized.checksum}
local ${id.environment} = (getgenv and getgenv()) or
    (getfenv and getfenv(0)) or _G
local ${id.unpackValues} = table.unpack or unpack
local ${id.packValues} = table.pack or function(...)
    return { n = select("#", ...), ... }
end
local ${id.closureMarker} = {}
local ${id.multiMarker} = {}
local ${id.cellMarker} = {}
local function ${id.makeMulti}(${id.value})
    return { [${id.multiMarker}] = true, v = ${id.value} }
end
local function ${id.isMulti}(${id.value})
    return type(${id.value}) == "table" and
        ${id.value}[${id.multiMarker}] == true
end
local function ${id.firstValue}(${id.value})
    if ${id.isMulti}(${id.value}) then
        return ${id.value}.v[1]
    end
    return ${id.value}
end
local function ${id.readRegister}(${id.frame}, ${id.index})
    local ${id.currentValue} = ${id.frame}.r[${id.index}]
    if type(${id.currentValue}) == "table" and
        ${id.currentValue}[${id.cellMarker}] == true then
        return ${id.currentValue}.v
    end
    return ${id.currentValue}
end
local function ${id.writeRegister}(${id.frame}, ${id.index}, ${id.value})
    local ${id.currentValue} = ${id.frame}.r[${id.index}]
    if type(${id.currentValue}) == "table" and
        ${id.currentValue}[${id.cellMarker}] == true then
        ${id.currentValue}.v = ${id.value}
    else
        ${id.frame}.r[${id.index}] = ${id.value}
    end
end
local function ${id.captureRegister}(${id.frame}, ${id.index})
    local ${id.currentValue} = ${id.frame}.r[${id.index}]
    if type(${id.currentValue}) == "table" and
        ${id.currentValue}[${id.cellMarker}] == true then
        return ${id.currentValue}
    end
    local ${id.value} = { [${id.cellMarker}] = true, v = ${id.currentValue} }
    ${id.frame}.r[${id.index}] = ${id.value}
    return ${id.value}
end
local function ${id.getConstant}(${id.index})
    local ${id.entry} = ${id.constants}[${id.index}]
    if not ${id.entry} then error("Invalid VM constant", 0) end
    if ${id.entry}[4] then return ${id.entry}[3] end
    local ${id.characters} = {}
    local ${id.raw} = ${id.entry}[2] or {}
    for ${id.keyIndex} = 1, #${id.raw} do
        local ${id.mask} = (
            ${id.constantKey} + ${id.index} * ${id.constantIndexSalt} +
            ${id.keyIndex} * ${id.constantByteSalt}
        ) % 256
        ${id.characters}[${id.keyIndex}] = string.char(
            bit32.bxor(${id.raw}[${id.keyIndex}], ${id.mask})
        )
    end
    local ${id.output} = table.concat(${id.characters})
    local ${id.value}
    if ${id.entry}[1] == 1 then
        ${id.value} = ${id.output}
    elseif ${id.entry}[1] == 2 then
        ${id.value} = tonumber(${id.output})
        if ${id.value} == nil then error("Invalid VM number", 0) end
    elseif ${id.entry}[1] == 3 then
        ${id.value} = ${id.output} == "1"
    end
    ${id.entry}[2] = nil
    ${id.entry}[3] = ${id.value}
    ${id.entry}[4] = true
    return ${id.value}
end
local function ${id.decodeWord}(${id.index})
    local ${id.mask} = (
        ${id.codeKey} + ${id.index} * ${id.codeSalt}
    ) % 4294967296
    return bit32.bxor(${id.code}[${id.index}], ${id.mask})
end
local function ${id.verifyIntegrity}()
    local ${id.checksum} = 0
    local ${id.checksumIndex} = 0
    for ${id.index} = 1, #${id.code} do
        ${id.checksumIndex} = ${id.checksumIndex} + 1
        ${id.checksum} = (
            ${id.checksum} * 33 +
            (${id.code}[${id.index}] % 65521) +
            ${id.checksumIndex}
        ) % 2147483647
    end
    for ${id.index} = 1, #${id.constants} do
        local ${id.entry} = ${id.constants}[${id.index}]
        ${id.checksumIndex} = ${id.checksumIndex} + 1
        ${id.checksum} = (
            ${id.checksum} * 33 + ${id.entry}[1] + ${id.checksumIndex}
        ) % 2147483647
        for ${id.keyIndex} = 1, #${id.entry}[2] do
            ${id.checksumIndex} = ${id.checksumIndex} + 1
            ${id.checksum} = (
                ${id.checksum} * 33 +
                ${id.entry}[2][${id.keyIndex}] +
                ${id.checksumIndex}
            ) % 2147483647
        end
    end
    return ${id.checksum} == ${id.expectedChecksum}
end
if not ${id.verifyIntegrity}() then
    error("Protected payload changed", 0)
end
local ${id.handlers} = {}
local ${id.execute}
${opcodeHandlers}
${id.execute} = function(${id.index}, ${id.arguments}, ${id.upvalues})
    local ${id.prototype} = ${id.prototypes}[${id.index}]
    if not ${id.prototype} then error("Invalid VM function", 0) end
    local ${id.frame} = {
        pc = 0,
        r = table.create and table.create(${id.prototype}[4]) or {},
        u = ${id.upvalues} or {},
        v = { n = 0 },
        done = false
    }
    for ${id.parameterIndex} = 1, ${id.prototype}[3] do
        ${id.frame}.r[${id.parameterIndex}] = ${id.arguments}[${id.parameterIndex}]
    end
    if ${id.prototype}[5] == 1 then
        for ${id.parameterIndex} = ${id.prototype}[3] + 1, ${id.arguments}.n do
            ${id.frame}.v.n = ${id.frame}.v.n + 1
            ${id.frame}.v[${id.frame}.v.n] = ${id.arguments}[${id.parameterIndex}]
        end
    end
    local ${id.instructionIndex} = ${id.prototype}[1] * 4 + 1
    while ${id.frame}.pc < ${id.prototype}[2] do
        local ${id.wordIndex} = ${id.instructionIndex} + ${id.frame}.pc * 4
        local ${id.opcode} = ${id.decodeWord}(${id.wordIndex})
        local ${id.operandA} = ${id.decodeWord}(${id.wordIndex} + 1)
        local ${id.operandB} = ${id.decodeWord}(${id.wordIndex} + 2)
        local ${id.operandC} = ${id.decodeWord}(${id.wordIndex} + 3)
        ${id.frame}.pc = ${id.frame}.pc + 1
        local ${id.handler} = ${id.handlers}[${id.opcode}]
        if not ${id.handler} then error("Invalid VM opcode", 0) end
        ${id.handler}(${id.frame}, ${id.operandA}, ${id.operandB}, ${id.operandC})
        if ${id.frame}.done then break end
    end
    local ${id.returnValues} = ${id.frame}.ret or { n = 0 }
    return ${id.unpackValues}(${id.returnValues}, 1, ${id.returnValues}.n)
end
return ${id.execute}(1, { n = 0 }, {})
`;
    return source;
}

function compileVm(program) {
    if (!program || program.type !== "Program" ||
        !program.body || program.body.type !== "Block") {
        throw new Error("VM profile could not read this Luau program.");
    }

    const builder = new VmBuilder();
    builder.addMain(program.body);
    const serialized = serialize(builder);
    const output = buildRuntime(serialized);

    return {
        output,
        vmInstructions: builder.prototypes.reduce(
            (total, prototype) => total + prototype.code.length,
            0
        ),
        vmConstants: builder.constants.length,
        vmFunctions: builder.prototypes.length,
        encodedStrings: builder.constants.filter(
            constant => constant.kind === "string"
        ).length,
        encodedNumbers: builder.constants.filter(
            constant => constant.kind === "number"
        ).length
    };
}

module.exports = { compileVm };
