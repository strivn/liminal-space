// Checks that turn a value of unknown type, read from outside (JSON, a caught error), into a known type.

// A JSON object as parsed from a file or an answer: field names to values not yet checked.
export type JsonObject = Record<string, unknown>;

// True for a JSON object: not null and not a list.
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reads the `code` Node puts on a system error (ENOENT, ECONNREFUSED, ...) from a caught value of unknown type.
// Undefined when the value has no string code, which prints as "undefined" in a message.
export function errorCode(error: unknown): string | undefined {
	if (isJsonObject(error) && typeof error.code === "string") {
		return error.code;
	}
	return undefined;
}
