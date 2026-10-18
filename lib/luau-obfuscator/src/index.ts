import { randomBytes, randomInt } from "node:crypto";
import {
  analyzeScopes,
  parse,
  print,
  type BaseNode,
  type CallExpression,
  type Identifier,
  type NumberLiteral,
  type Program,
  type StringLiteral,
  type TableExpression,
} from "luau-parser";

const MAX_SOURCE_BYTES = 1024 * 1024;
const PROFILES = ["standard", "strong"] as const;
const utf8 = new TextEncoder();

export type ObfuscationProfile = (typeof PROFILES)[number];

export interface ObfuscationResult {
  output: string;
  profile: ObfuscationProfile;
  inputBytes: number;
  outputBytes: number;
  renamedBindings: number;
  encodedStrings: number;
}

interface ParsedString {
  bytes: number[];
  decoded: string;
}

interface Position extends BaseNode {
  line: { start: number; end: number };
  column: { start: number; end: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasPosition(value: Record<string, unknown>): value is Record<string, unknown> & Position {
  return (
    isRecord(value.line) &&
    isRecord(value.column) &&
    typeof value.line.start === "number" &&
    typeof value.line.end === "number" &&
    typeof value.column.start === "number" &&
    typeof value.column.end === "number"
  );
}

function uniqueIdentifier(source: string, used: Set<string>): string {
  for (;;) {
    const candidate = `__sp_${randomBytes(7).toString("hex")}`;
    if (!used.has(candidate) && !source.includes(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function collectIdentifierNames(program: Program): Set<string> {
  const names = new Set<string>();

  function visit(value: unknown): void {
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

function renameLocalBindings(program: Program, source: string): number {
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

function pushUtf8(bytes: number[], value: string): void {
  bytes.push(...utf8.encode(value));
}

function parseQuotedString(raw: string): ParsedString {
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"') || raw.at(-1) !== quote) {
    throw new Error("Unsupported Luau string literal.");
  }

  const bytes: number[] = [];
  let decoded = "";
  let i = 1;
  const end = raw.length - 1;

  while (i < end) {
    const char = raw[i++];

    if (char !== "\\") {
      const codePoint = char.codePointAt(0)!;
      const value = String.fromCodePoint(codePoint);
      if (codePoint > 0xffff) i++;
      decoded += value;
      pushUtf8(bytes, value);
      continue;
    }

    if (i >= end) throw new Error("Incomplete escape in Luau string.");
    const escape = raw[i++];

    const simpleEscapes: Record<string, number> = {
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
      if (byte > 255) throw new Error("Decimal string escape exceeds 255.");
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

function getStringBytes(literal: StringLiteral): number[] {
  const raw = literal.raw;
  let parsed: ParsedString;

  if (/^\[(=*)\[/.test(raw)) {
    parsed = { bytes: Array.from(utf8.encode(literal.value)), decoded: literal.value };
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

function positionOf(node: BaseNode): Position {
  return {
    line: { ...node.line },
    column: { ...node.column },
  };
}

function makeIdentifier(name: string, position: Position): Identifier {
  return {
    type: "Identifier",
    name,
    line: { ...position.line },
    column: { ...position.column },
  };
}

function makeNumber(value: number, position: Position): NumberLiteral {
  return {
    type: "NumberLiteral",
    value,
    raw: String(value),
    line: { ...position.line },
    column: { ...position.column },
  };
}

function makeEncodedStringCall(
  literal: StringLiteral,
  decoderName: string,
): CallExpression {
  const position = positionOf(literal);
  const key = randomInt(1, 256);
  const stride = randomInt(1, 256);
  const bytes = getStringBytes(literal).map(
    (byte, index) => byte ^ ((key + (index + 1) * stride) % 256),
  );

  const byteTable: TableExpression = {
    type: "TableExpression",
    fields: bytes.map((value) => ({
      type: "TableFieldPositional" as const,
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
    ],
    line: { ...position.line },
    column: { ...position.column },
  };
}

interface EncodedStringExpressions {
  count: number;
  decoderName: string;
}

function encodeStringExpressions(
  program: Program,
  source: string,
): EncodedStringExpressions {
  const usedNames = collectIdentifierNames(program);
  const decoderName = uniqueIdentifier(source, usedNames);
  let encodedCount = 0;

  function rewrite(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(rewrite);
    }
    if (!isRecord(value)) return value;

    if (
      value.type === "StringLiteral" &&
      typeof value.value === "string" &&
      typeof value.raw === "string" &&
      hasPosition(value)
    ) {
      encodedCount++;
      return makeEncodedStringCall(value as unknown as StringLiteral, decoderName);
    }

    for (const [key, child] of Object.entries(value)) {
      if (key !== "line" && key !== "column") {
        value[key] = rewrite(child);
      }
    }
    return value;
  }

  rewrite(program);
  return { count: encodedCount, decoderName };
}

function extractLeadingDirectives(source: string): string[] {
  const directives: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) break;
    if (trimmed.startsWith("--!")) directives.push(trimmed);
  }
  return directives;
}

function createDecoderSource(
  name: string,
  source: string,
  program: Program,
): string {
  const usedNames = collectIdentifierNames(program);
  const charName = uniqueIdentifier(source, usedNames);
  const xorName = uniqueIdentifier(source, usedNames);
  const concatName = uniqueIdentifier(source, usedNames);
  const createName = uniqueIdentifier(source, usedNames);
  const dataName = uniqueIdentifier(source, usedNames);
  const keyName = uniqueIdentifier(source, usedNames);
  const strideName = uniqueIdentifier(source, usedNames);
  const resultName = uniqueIdentifier(source, usedNames);
  const indexName = uniqueIdentifier(source, usedNames);

  return `local ${charName} = string.char
local ${xorName} = bit32.bxor
local ${concatName} = table.concat
local ${createName} = table.create
local function ${name}(${dataName}: {number}, ${keyName}: number, ${strideName}: number): string
    local ${resultName}: {string} = ${createName}(#${dataName})
    for ${indexName} = 1, #${dataName} do
        ${resultName}[${indexName}] = ${charName}(${xorName}(${dataName}[${indexName}], (${keyName} + ${indexName} * ${strideName}) % 256))
    end
    return ${concatName}(${resultName})
end
`;
}

function validateSource(source: string, profile: string): asserts profile is ObfuscationProfile {
  if (typeof source !== "string") {
    throw new TypeError("Source must be text.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error("Source exceeds the 1 MB limit.");
  }
  if (!source.trim()) {
    throw new Error("Source is empty.");
  }
  if (!(PROFILES as readonly string[]).includes(profile)) {
    throw new Error("Unknown profile.");
  }
}

export function obfuscateLuau(
  source: string,
  profile: ObfuscationProfile = "standard",
): ObfuscationResult {
  validateSource(source, profile);

  const program = parse(source);
  const renamedBindings = renameLocalBindings(program, source);
  const encoded = profile === "strong"
    ? encodeStringExpressions(program, source)
    : undefined;
  const encodedStrings = encoded?.count ?? 0;

  const directives = extractLeadingDirectives(source);
  let output = print(program);

  if (encodedStrings > 0) {
    output = createDecoderSource(encoded!.decoderName, source, program) + output;
  }
  if (directives.length > 0) {
    output = `${directives.join("\n")}\n${output}`;
  }

  // Fail closed if our output is not valid according to the parser.
  parse(output);

  return {
    output,
    profile,
    inputBytes: Buffer.byteLength(source, "utf8"),
    outputBytes: Buffer.byteLength(output, "utf8"),
    renamedBindings,
    encodedStrings,
  };
}
