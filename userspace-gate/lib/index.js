import { dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { canonicalPath, writableRoots } from "@deepseek-ai/dsh-sandbox";
import { stat } from "node:fs/promises";
//#region ../../../vendor/cosmokit/src/misc.ts
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region lib/types/bash-scan.js
/**
 * Pure user-space scanner for STATIC file-write intents inside a shell command
 * string. It is the `userspace-gate` plugin's approximation of the bash
 * runner's kernel confinement: it extracts the literal (fully static) paths a
 * command writes, mutates, or deletes — redirection targets, mutation-command
 * operands, and known option values — so a containment gate can deny targets
 * outside the writable roots without any kernel feature.
 *
 * The scanner is deliberately CONSERVATIVE about what it calls static: any
 * word containing an expansion (`$`, backticks, `~`, globs, braces, command
 * substitution, escapes) is not a candidate, and relative targets are only
 * emitted when the command's working directory is statically known (a
 * preceding `cd`). Dynamic targets are the kernel runner's job; this scanner
 * never guesses. The documented gap is exactly "a write whose target cannot
 * be statically determined", which the kernel-level `ctx.sandbox` backend
 * still governs when the session runs under `workspace-write`.
 *
 * @module dsh-userspace-gate/bash-scan
 */
/** Words that never name the command: leading wrappers with their flags. */
const WRAPPERS = {
    sudo: ['-u', '-g', '--user', '--group'],
    doas: ['-u'],
    env: [],
    command: [],
    nohup: [],
    nice: ['-n'],
    // `time -p` takes a BOOLEAN `-p` (POSIX mode), not a value; treating it as a
    // value-taking flag skipped the real command entirely (`time -p rm -rf /etc/x`
    // produced no targets).
    time: [],
    taskset: ['-c', '-p'],
    ionice: ['-c', '-n', '-p'],
    stdbuf: ['-i', '-o', '-e'],
    // `exec sh -c '...'` replaces the shell with `sh`, so the trailing command
    // is the very command that runs; `exec` itself takes no command-name flag.
    exec: [],
};
/**
 * Commands with file-write intent. Read-only reference operands (chmod's
 * `--reference`, touch's `-r`, …) are deliberately absent from `options`: the
 * scanner emits only MUTATION targets, never read sources.
 */
const MUTATION_COMMANDS = {
    touch: { operands: 'all', options: [], skipValues: ['-t', '-d', '-r', '--reference', '--time'] },
    mkdir: { operands: 'all', options: [] },
    rmdir: { operands: 'all', options: [] },
    rm: { operands: 'all', options: [] },
    unlink: { operands: 'all', options: [] },
    truncate: { operands: 'all', options: [], skipValues: ['-s', '--size', '-r', '--reference'] },
    chmod: { operands: 'all-skip-first', options: [], skipValues: ['--reference'] },
    chown: { operands: 'all-skip-first', options: [], skipValues: ['--reference'] },
    tee: { operands: 'all', options: [] },
    mv: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
    cp: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
    ln: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
    install: { operands: 'last-is-dest', options: ['-t', '--target-directory'] },
    // `dd` is special-cased: only `of=` names the write target; `if=`, `bs=`,
    // `count=`, … are reads or metadata and must never be emitted (a pure-read
    // `dd if=… of=/dev/null` is not a file write).
    dd: { operands: 'all', options: [] },
    curl: { operands: 'none', options: ['-o', '--output'] },
    wget: { operands: 'none', options: ['-O', '--output-document'] },
    tar: { operands: 'none', options: ['-C', '--directory', '-f', '--file'] },
    unzip: { operands: 'none', options: ['-d'] },
};
/** Shells whose `-c` VALUE (and heredoc body) is a nested command scanned recursively. */
const NESTED_SHELLS = {
    bash: ['-c'],
    sh: ['-c'],
    dash: ['-c'],
    ksh: ['-c'],
    zsh: ['-c'],
    fish: ['-c'],
};
/** Characters that make a word dynamic (expansions, globs, escapes, nesting). */
const DYNAMIC = /[\$`~*?\[\]{}()\\]/;
/** Operators that end one command and start the next (or a subshell). */
const COMMAND_BOUNDARIES = new Set([';', '&', '|', '(', ')', '&&', '||', '|&', ';;']);
/** Operators that redirect a stream; their following word is a target, not a command. */
const REDIRECT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&', '<&', '<', '<<', '<<-', '<<<']);
/** Heredoc operators whose BODY is command text when the command is a shell. */
const HEREDOC_OPS = new Set(['<<', '<<-']);
/**
 * Tokenize a shell command into words and operators, tracking quotes. This is
 * a pragmatic scanner, not a full shell grammar: it understands quoting and
 * the operators relevant to redirection and command boundaries, and treats
 * everything else as word text.
 */
function tokenize(command) {
    const tokens = [];
    let word = '';
    let quoted = false;
    let quote;
    const flushWord = () => {
        if (word.length > 0 || quoted) {
            tokens.push({ text: word, op: false, quoted });
            word = '';
            quoted = false;
        }
    };
    for (let i = 0; i < command.length; i += 1) {
        const char = command[i];
        if (char === undefined)
            break;
        // An unquoted `#` at a word boundary starts a comment: everything after
        // it is not executed by the shell and must not contribute targets.
        if (char === '#' && quote === undefined && word.length === 0)
            break;
        if (char === '\\' && quote !== "'") {
            // A backslash makes the word dynamic for this scanner: we cannot cheaply
            // decide whether the escaped character was significant.
            word += char;
            continue;
        }
        if (quote === "'" || quote === '"') {
            if (char === quote) {
                quote = undefined;
                quoted = true;
            }
            else {
                word += char;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            quoted = true;
            continue;
        }
        if (/\s/.test(char)) {
            flushWord();
            continue;
        }
        const rest = command.slice(i);
        const two = rest.slice(0, 2);
        const three = rest.slice(0, 3);
        let op;
        if (three === '<<<' || three === '<<-' || three === '&>>')
            op = three;
        else if (two === '<<' || two === '>>' || two === '>&' || two === '<&' || two === '<>' || two === '>|' || two === '&>' || two === '||' || two === '&&' || two === ';;')
            op = two;
        else if (char === '>' || char === '<' || char === '|' || char === '&' || char === ';' || char === '(' || char === ')')
            op = char;
        if (op !== undefined) {
            flushWord();
            tokens.push({ text: op, op: true, quoted: false });
            i += op.length - 1;
            continue;
        }
        word += char;
    }
    if (quote !== undefined) {
        // Unterminated quote: flush the tail as a word so it is scanned (and, being
        // quoted, counts as a static literal only if fully quoted — it is not).
        word += '"';
    }
    flushWord();
    return tokens;
}
/** Whether a word is a static literal path (no expansions, escapes, or globs). */
function staticPath(word) {
    if (word.length === 0)
        return undefined;
    if (DYNAMIC.test(word))
        return undefined;
    return word;
}
/** A fd-number word (`2`, `1`), an fd move (`2>&1-` closes via `1-`), or `-` used after `>&` / `<&`. */
function isFdReference(word) {
    return word === '-' || /^[0-9]+-?$/.test(word);
}
/** Strip one layer of surrounding quotes from a raw word for nested scanning. */
function unquoteForNested(raw) {
    if (raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))) {
        return raw.slice(1, -1);
    }
    return raw;
}
/** Absolute-path prefix on POSIX and Windows. */
function isAbsoluteSpelling(path) {
    return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}
/** Whether `word` looks like chmod's mode word or chown's owner spec (not a path). */
function isModeOrOwnerWord(word, command) {
    if (command === 'chmod') {
        return /^[0-7]{1,4}$/.test(word) || /^[ugoa]*[+-=][rwxXstugo]*$/.test(word);
    }
    // chown: `[user][:group]` — never a path (no `/`).
    return /^[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/.test(word) && !word.includes('/');
}
/**
 * Parse a short-option cluster or an attached short-option value
 * (`-czf out.tar`, `-o/etc/x`, `-o=/etc/x`, `-t/etc`). Scans the characters
 * after the leading `-`; the first character whose flag is a value-taking
 * option consumes the rest of the word as its value (or records the flag to
 * take the next word). Returns whether the word was recognized as an option
 * cluster at all.
 */
function parseShortCluster(word, mutation, state) {
    const chars = word.slice(1);
    for (let ci = 0; ci < chars.length; ci += 1) {
        const flag = '-' + chars[ci];
        const takesValue = mutation.options.includes(flag);
        const skipsValue = mutation.skipValues?.includes(flag) ?? false;
        if (!takesValue && !skipsValue)
            continue;
        let value = chars.slice(ci + 1);
        if (value.startsWith('='))
            value = value.slice(1);
        if (value.length > 0) {
            if (flag === '-t' || flag === '--target-directory')
                state.targetDir = value;
            else if (skipsValue) { /* read reference / metadata: never a target */ }
            else
                state.optionValues.push(value);
        }
        else {
            state.optionValue = flag;
        }
        return true;
    }
    return false;
}
/**
 * Scan one shell command for static write targets.
 * @param command - the shell command text (the `bash` tool's `command` argument).
 * @param initialCwd - the statically known starting working directory
 *   (absolute when the tool call carries a `workdir` argument, `''` when the
 *   command starts in the session workspace, `undefined` when unknown); the
 *   gate resolves relative spellings against the same base.
 * @returns the deduplicated static targets, in first-appearance order.
 */
function scanBashTargets(command, initialCwd = '') {
    const found = [];
    const seen = new Set();
    const add = (path, kind) => {
        if (path.length === 0)
            return;
        if (seen.has(path))
            return;
        seen.add(path);
        found.push({ path, kind });
    };
    const tokens = tokenize(command);
    let i = 0;
    // Static working directory tracked across `cd` commands; `undefined` once a
    // dynamic `cd` (or bare `cd` / `cd -`) makes relative targets unknowable.
    let cwd = initialCwd;
    // Set when the next word is the target of a write redirection.
    let pendingWriteRedirect = false;
    // Set when the next word is the fd-dup or redirect target of `>&` / `<&`.
    let pendingFdDup = false;
    while (i < tokens.length) {
        const token = tokens[i];
        if (token === undefined)
            break;
        if (!token.op) {
            if (pendingWriteRedirect) {
                const target = staticPath(token.text);
                if (target !== undefined)
                    add(target, 'redirect');
                pendingWriteRedirect = false;
            }
            else if (pendingFdDup) {
                // `2>&1` / `>&-` dup an existing descriptor (no file target);
                // `>& file` is the legacy both-streams redirect — a write target.
                if (!isFdReference(token.text)) {
                    const target = staticPath(token.text);
                    if (target !== undefined)
                        add(target, 'redirect');
                }
                pendingFdDup = false;
            }
            i += 1;
            continue;
        }
        const op = token.text;
        if (op === '>' || op === '>>' || op === '>|' || op === '&>' || op === '&>>' || op === '<>') {
            pendingWriteRedirect = true;
            pendingFdDup = false;
            i += 1;
            continue;
        }
        if (op === '>&' || op === '<&') {
            pendingWriteRedirect = false;
            pendingFdDup = true;
            i += 1;
            continue;
        }
        if (op === '<' || op === '<<' || op === '<<-' || op === '<<<') {
            // Input redirects and heredocs do not write files; `<<`'s delimiter word
            // is consumed but never a target. A `> file` before `<<EOF` was already
            // handled as its own redirect.
            pendingWriteRedirect = false;
            pendingFdDup = false;
            i += 1;
            continue;
        }
        if (COMMAND_BOUNDARIES.has(op)) {
            pendingWriteRedirect = false;
            pendingFdDup = false;
            i += 1;
            continue;
        }
        // Any other operator (||, &&, ;;, |&…): not a redirect; keep scanning.
        pendingWriteRedirect = false;
        pendingFdDup = false;
        i += 1;
    }
    // Second pass: command boundaries and operands. The redirect pass above is
    // independent, so the two passes compose without sharing state.
    let cursor = 0;
    let commandStart = true;
    while (cursor < tokens.length) {
        const token = tokens[cursor];
        if (token === undefined)
            break;
        if (token.op) {
            if (REDIRECT_OPS.has(token.text)) {
                // A redirect's following word is its target (already extracted by the
                // redirect pass) or an fd reference — never a new command.
                const next = tokens[cursor + 1];
                if (next !== undefined && !next.op)
                    cursor += 1;
                commandStart = false;
            }
            else {
                commandStart = true;
            }
            cursor += 1;
            continue;
        }
        if (!commandStart) {
            cursor += 1;
            continue;
        }
        const word = staticPath(token.text);
        if (word === undefined) {
            commandStart = false;
            cursor += 1;
            continue;
        }
        // Environment-assignment prefixes (`FOO=1 rm …`, `A=1 B=2 touch …`) are
        // not commands; skip the whole run of them before resolving the command
        // word. Without this, `FOO=1 rm -rf /etc/x` lost `rm` entirely.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
            cursor += 1;
            continue;
        }
        // Resolve wrapper chains (sudo/env/…/exec) to the real command.
        let commandWord = word;
        let j = cursor + 1;
        for (;;) {
            const wrapper = WRAPPERS[commandWord];
            if (wrapper === undefined)
                break;
            // Skip the wrapper's flags (with their values) and env assignments.
            while (j < tokens.length) {
                const t = tokens[j];
                if (t === undefined || t.op)
                    break;
                const w = staticPath(t.text);
                if (w === undefined)
                    break;
                if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
                    j += 1;
                    continue;
                }
                const takesValue = wrapper.some(flag => w === flag);
                if (takesValue) {
                    j += 2;
                    continue;
                }
                if (w.startsWith('-')) {
                    j += 1;
                    continue;
                }
                break;
            }
            const next = tokens[j];
            if (next === undefined || next.op) {
                commandWord = '';
                break;
            }
            commandWord = next.text;
            j += 1;
        }
        if (commandWord === '') {
            commandStart = false;
            cursor += 1;
            continue;
        }
        // `cd` changes the tracked cwd for subsequent relative operands. The
        // initial cwd is the tool `workdir` (absolute) or `''` (the session
        // workspace, spelled relatively); a relative `cd` keeps the spelling
        // relative so the gate resolves it against the workspace root, while an
        // absolute `cd` leaves the workspace. A bare `cd` (to `$HOME`), `cd -`
        // (to `$OLDPWD`), or a dynamic target makes the cwd unknowable.
        if (commandWord === 'cd') {
            const target = tokens[j];
            if (target === undefined || target.op) {
                cwd = undefined;
                cursor = j;
                commandStart = true;
                continue;
            }
            const path = staticPath(target.text);
            if (path === undefined || path === '-') {
                cwd = undefined;
                cursor = j + 1;
                commandStart = true;
                continue;
            }
            cwd = isAbsoluteSpelling(path) ? path : cwd === '' ? path : `${cwd}/${path}`;
            cursor = j + 1;
            commandStart = false;
            continue;
        }
        // Nested shell: recursively scan every `-c` value AND the body of a
        // heredoc handed to the shell (`bash <<EOF … EOF` — the body is a script
        // that runs with the harness authority). The nested scan inherits the
        // tracked cwd.
        const shellOptions = NESTED_SHELLS[commandWord];
        if (shellOptions !== undefined) {
            let k = j;
            while (k < tokens.length) {
                const t = tokens[k];
                if (t === undefined)
                    break;
                if (!t.op) {
                    const w = staticPath(t.text);
                    if (w === undefined)
                        break;
                    if (shellOptions.includes(w)) {
                        const next = tokens[k + 1];
                        if (next !== undefined && !next.op) {
                            for (const nested of scanBashTargets(unquoteForNested(next.text), cwd)) {
                                add(nested.path, nested.kind);
                            }
                        }
                        k += 2;
                        continue;
                    }
                    k += 1;
                    continue;
                }
                if (HEREDOC_OPS.has(t.text)) {
                    const delimTok = tokens[k + 1];
                    if (delimTok !== undefined && !delimTok.op) {
                        const delim = unquoteForNested(delimTok.text);
                        const body = [];
                        let m = k + 2;
                        let closed = false;
                        while (m < tokens.length) {
                            const mt = tokens[m];
                            if (mt === undefined)
                                break;
                            if (!mt.op && unquoteForNested(mt.text) === delim) {
                                closed = true;
                                break;
                            }
                            body.push(mt.text);
                            m += 1;
                        }
                        const text = body.join(' ');
                        if (text.trim().length > 0) {
                            for (const nested of scanBashTargets(text, cwd)) {
                                add(nested.path, nested.kind);
                            }
                        }
                        k = closed ? m + 1 : m;
                        continue;
                    }
                    break;
                }
                // Any other operator ends this shell invocation's argument list.
                break;
            }
            cursor = j;
            commandStart = false;
            continue;
        }
        const mutation = MUTATION_COMMANDS[commandWord];
        if (mutation === undefined) {
            cursor = j;
            commandStart = false;
            continue;
        }
        // `dd` special case: only `of=` is a write target; `if=`/`bs=`/`count=`/
        // … are reads or metadata and never emitted.
        if (commandWord === 'dd') {
            let kk = j;
            while (kk < tokens.length) {
                const t = tokens[kk];
                if (t === undefined || t.op)
                    break;
                const w = staticPath(t.text);
                if (w === undefined)
                    break;
                if (w.startsWith('of=')) {
                    const value = w.slice(3);
                    if (value.length > 0) {
                        if (isAbsoluteSpelling(value))
                            add(value, 'operand');
                        else if (cwd !== undefined)
                            add(cwd === '' ? value : `${cwd}/${value}`, 'operand');
                    }
                }
                kk += 1;
            }
            cursor = kk;
            commandStart = false;
            continue;
        }
        // Scan this mutation command's operands.
        const positionals = [];
        const optionValues = [];
        let targetDir;
        let optionValue;
        let k = j;
        let positionalOnly = false;
        // Set when the scan stops at a DYNAMIC word: any later positional — the
        // real destination of a last-is-dest command, for example — is invisible,
        // so the last static positional must never be mistaken for it.
        let sawDynamic = false;
        while (k < tokens.length) {
            const t = tokens[k];
            if (t === undefined || t.op)
                break;
            const w = staticPath(t.text);
            if (w === undefined) {
                sawDynamic = true;
                break;
            }
            if (!positionalOnly && w.startsWith('-') && w !== '-') {
                if (w === '--') {
                    positionalOnly = true;
                    k += 1;
                    continue;
                }
                const eq = w.indexOf('=');
                if (eq === -1) {
                    // Short-option cluster or attached value (`-czf out.tar`,
                    // `-o/etc/x`, `-o=/etc/x`, `-t/etc`), or a plain boolean option.
                    if (w.length > 2 && w[1] !== '-') {
                        const clusterState = { optionValues, optionValue, targetDir };
                        parseShortCluster(w, mutation, clusterState);
                        optionValue = clusterState.optionValue;
                        targetDir = clusterState.targetDir;
                        k += 1;
                        continue;
                    }
                    const flag = w;
                    const takesValue = mutation.options.includes(flag);
                    const skipsValue = mutation.skipValues?.includes(flag) ?? false;
                    if (takesValue || skipsValue)
                        optionValue = flag;
                    k += 1;
                    continue;
                }
                const flag = w.slice(0, eq);
                const value = w.slice(eq + 1);
                const takesValue = mutation.options.includes(flag);
                const skipsValue = mutation.skipValues?.includes(flag) ?? false;
                if (takesValue || skipsValue) {
                    if (value.length > 0) {
                        if (flag === '-t' || flag === '--target-directory')
                            targetDir = value;
                        else if (skipsValue) { /* read reference / metadata: never a target */ }
                        else
                            optionValues.push(value);
                    }
                    else {
                        optionValue = flag;
                    }
                }
                k += 1;
                continue;
            }
            if (optionValue !== undefined) {
                if (optionValue === '-t' || optionValue === '--target-directory')
                    targetDir = w;
                else if (mutation.skipValues?.includes(optionValue) ?? false) { /* read reference / metadata: never a target */ }
                else
                    optionValues.push(w);
                optionValue = undefined;
                k += 1;
                continue;
            }
            positionals.push(w);
            k += 1;
        }
        // Select the write targets per the command's operand policy.
        let targets;
        if (mutation.operands === 'none') {
            targets = optionValues;
        }
        else if (mutation.operands === 'last-is-dest') {
            // `cp a b $dyn` / `cp a $dyn b`: when the operand scan stopped at a
            // dynamic word, the real destination is unknown (it may be that very
            // word's expansion or a later one) — never mistake the last STATIC
            // positional (a source) for the destination. An explicit `-t` /
            // `--target-directory` destination is still known.
            const dest = targetDir ?? (positionals.length > 0 && !sawDynamic ? positionals[positionals.length - 1] : undefined);
            targets = dest === undefined ? [] : [dest];
        }
        else if (mutation.operands === 'all-skip-first') {
            // chmod's mode word / chown's owner spec is the first positional — but
            // only when it actually looks like one (`chmod --reference=/etc/x
            // /etc/y` has no mode word and `/etc/y` IS the target).
            const skip = positionals.length > 0 && isModeOrOwnerWord(positionals[0], commandWord);
            targets = [...positionals.slice(skip ? 1 : 0), ...optionValues];
        }
        else {
            targets = [...positionals, ...optionValues];
        }
        for (const target of targets) {
            if (isAbsoluteSpelling(target)) {
                add(target, 'operand');
            }
            else if (cwd !== undefined) {
                // `''` means "relative to the session workspace"; the gate resolves it
                // against the workspace root.
                add(cwd === '' ? target : `${cwd}/${target}`, 'operand');
            }
            // cwd unknown: a relative target could land anywhere; only the kernel
            // runner can decide it, so the scanner stays silent.
        }
        cursor = k;
        commandStart = false;
    }
    return found;
}
//#endregion
//#region lib/types/containment.js
/**
* Path-containment mechanics for the workspace guard, ported from
* `@deepseek-ai/dsh-fs-sandbox`'s `containment.ts` so the guard's gate cannot
* drift from the filesystem fence it mirrors: canonical spellings take the
* fast lexical path; filesystem identity supplies the conservative fallback
* for alias-equivalent roots such as Windows 8.3 names and casing. The two
* implementations are pinned to each other by test.
* @module dsh-userspace-gate/containment
*/
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
function isMissing(error) {
	const code = error.code;
	return MISSING_CODES.has(code);
}
function comparablePath(path, caseSensitive) {
	return caseSensitive ? path : path.toLowerCase();
}
function isLexicallyUnder(path, root, caseSensitive) {
	const comparableTarget = comparablePath(path, caseSensitive);
	const comparableRoot = comparablePath(root, caseSensitive);
	if (comparableTarget === comparableRoot) return true;
	const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
	return comparableTarget.startsWith(prefix);
}
async function statIfPresent(path) {
	try {
		return await stat(path, { bigint: true });
	} catch (error) {
		/* v8 ignore else -- a non-missing stat failure requires a host permission or I/O fault after resolve reached this ancestor. */
		if (isMissing(error)) return void 0;
		/* v8 ignore next -- requires a host permission or I/O fault after resolve already reached this ancestor. */
		throw error;
	}
}
function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}
/**
* Determine whether a canonical target is a writable root or lies beneath it.
* The lexical fast path handles normal canonical spellings. When spellings
* differ, walk the target's existing ancestors and compare filesystem identity
* with the root; this recognizes Windows long-name/8.3 aliases and casing
* without weakening containment to a textual approximation.
* @param path - canonical target key, which may end in a missing suffix.
* @param root - canonical writable root.
* @param caseSensitive - whether lexical comparison preserves case; defaults
*   to the host filesystem convention used by supported platforms.
* @returns whether the target is the root or a descendant of it.
*/
async function isPathUnder(path, root, caseSensitive = process.platform !== "win32") {
	if (isLexicallyUnder(path, root, caseSensitive)) return true;
	const rootInfo = await statIfPresent(root);
	if (!rootInfo) return false;
	let ancestor = path;
	while (true) {
		const ancestorInfo = await statIfPresent(ancestor);
		if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
}
//#endregion
//#region lib/types/gate.js
/**
 * The workspace guard's containment gate: given the static targets a tool call
 * would write, decide whether the call may proceed under the session's
 * resolved sandbox policy. Mirrors the `workspace-write` semantics of the
 * filesystem fence (`@deepseek-ai/dsh-fs-sandbox`) and the bash runner's
 * Seatbelt profile: a target is writable only when it canonicalizes under the
 * policy's workspace root or a platform temp area — the SAME writable-root
 * set, derived from the one `writableRoots` function so the guard cannot
 * drift from the other enforcement dialects.
 * @module dsh-userspace-gate/gate
 */



/** Shell stream sinks the bash runners always grant; the guard mirrors that grant for shell tools. */
const SHELL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin']);
/** The standard fd-number sinks (`/dev/fd/0|1|2`); higher fds may alias real files. */
const DEV_FD_SINKS = /^\/dev\/fd\/[0-2]$/;
/**
 * Whether an absolute target is a granted shell sink. Matches the raw
 * spelling, the lexically-collapsed spelling (`/dev//stdout` → `/dev/stdout`),
 * and the canonical one (a symlinked `/dev/stdout`), so alias spellings cannot
 * be mistaken for file writes even on hosts where the `/dev/std*` nodes do not
 * exist (realpath then fails and the canonical fallback is the raw spelling).
 */
function isShellSink(absolute, canonical) {
    const normalized = absolute.replace(/\/{2,}/g, '/');
    if (SHELL_SINKS.has(normalized))
        return true;
    if (DEV_FD_SINKS.test(normalized))
        return true;
    return SHELL_SINKS.has(canonical);
}
/**
 * The first target that canonicalizes OUTSIDE every writable root, or
 * `undefined` when every target is contained. Non-`workspace-write` policies
 * are never this gate's business and return `undefined` immediately — the
 * filesystem fence owns `read-only`, and `danger-full-access` passes through.
 * @param targets - the static write targets extracted from the tool call.
 * @param policy - the session's resolved sandbox policy.
 * @param allowSinks - whether the shell stream sinks (`/dev/null`,
 *   `/dev/stdout|stderr|stdin`, `/dev/fd/0|1|2`) are granted (the bash runners
 *   grant them; the filesystem fence does not).
 * @returns the first violating target, or `undefined` when all are contained.
 */
async function firstUncontainedTarget(targets, policy, allowSinks = false) {
    if (policy.mode !== 'workspace-write')
        return undefined;
    const roots = writableRoots(policy);
    for (const target of targets) {
        const absolute = isAbsolute(target) ? target : resolvePath(policy.workspaceRoot, target);
        const canonical = canonicalPath(absolute);
        if (allowSinks && isShellSink(absolute, canonical))
            continue;
        let contained = false;
        for (const root of roots) {
            if (await isPathUnder(canonical, root)) {
                contained = true;
                break;
            }
        }
        if (!contained)
            return target;
    }
    return undefined;
}
//#endregion
//#region lib/types/index.js
/**
 * Workspace-write guard: a pure-user-space equivalent of the
 * `workspace-write` sandbox at the tool-call layer. A `tools/pre-execute`
 * listener resolves the calling session's sandbox policy and, when the
 * resolved mode is `workspace-write`, denies `write`/`edit` calls and bash
 * calls whose STATIC write targets canonicalize outside the session workspace
 * and platform temp roots.
 *
 * Relationship to the shipped sandbox: the filesystem fence
 * (`@deepseek-ai/dsh-fs-sandbox`) and the bash runners (`@deepseek-ai/dsh-bash-sandbox`)
 * already confine `workspace-write` executions where they are mounted and
 * usable. This guard is the defense-in-depth and fallback layer: it needs no
 * kernel feature, works in compositions that mount the plain local filesystem,
 * and covers bash write intents the scanner can determine statically. It
 * follows the session mode — under `read-only` the fence owns denial (this
 * guard restores the read-only rule for fs tools in fence-less compositions),
 * under `danger-full-access` the guard passes through — and it never blocks a
 * call carrying an escalation (`sandbox_permissions`), whose approval flow
 * belongs to the tool layer. Denials carry the stable
 * `[userspace-gate: …]` marker.
 *
 * The bash scanner is best-effort by design: targets it cannot statically
 * resolve are left to the kernel runner, which is the authoritative boundary
 * for untrusted code. See the package README for the exact scope.
 *
 * @module dsh-userspace-gate
 */




/** Cordis plugin name used by loader diagnostics. */
const name = 'userspace-gate';
/** The sandbox-policy service this guard resolves every call against; without it the guard cannot decide and must not load silently. */
const inject = ['sandboxPolicy'];
/** The stable model-facing denial marker; the tool layer's fs marker is `[sandbox: …]`, this guard's is scoped to its own name. */
const DENY_MARKER = '[userspace-gate: file access denied under workspace-write mode]';
/** The read-only denial marker, mirroring the readonly-gate's wording for fs tools. */
const READONLY_DENY_MARKER = '[userspace-gate: file access denied under read-only mode]';
const Config = Schema.object({
    fsTools: Schema.array(Schema.string()).default(['write', 'edit']),
    shellTools: Schema.array(Schema.string()).default(['bash']),
});
/** Whether the call carries the tool layer's escalation argument (approval flow stays in the tool layer). */
function carriesEscalation(exec) {
    if (exec.arguments === null || typeof exec.arguments !== 'object')
        return false;
    return typeof exec.arguments.sandbox_permissions === 'string';
}
/** The static write targets a gated tool call would touch. */
function extractTargets(exec, config, policy) {
    const args = exec.arguments;
    if (args === null || typeof args !== 'object')
        return [];
    if (config.fsTools?.includes(exec.name)) {
        const filePath = args.file_path;
        return typeof filePath === 'string' && filePath.length > 0 ? [{ path: filePath, kind: 'operand' }] : [];
    }
    if (config.shellTools?.includes(exec.name)) {
        const command = args.command;
        if (typeof command !== 'string' || command.length === 0)
            return [];
        // The bash tool's `workdir` argument moves the command's starting
        // directory: relative targets must resolve against it, not the
        // workspace root, or `workdir: /etc` + `touch x` would read as
        // contained.
        const workdir = args.workdir;
        const initialCwd = typeof workdir === 'string' && workdir.length > 0
            ? (isAbsolute(workdir) ? workdir : resolvePath(policy.workspaceRoot, workdir))
            : '';
        return scanBashTargets(command, initialCwd);
    }
    return [];
}
/** The model-facing denial reason: stable marker, the violating target, and the escalation path. */
function denyReason(target) {
    return `${DENY_MARKER} target "${target}" lies outside the session workspace and platform temporary directories. `
        + 'Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; '
        + 'the retry asks for approval.';
}
/** The read-only denial reason for fs tools in fence-less compositions. */
function readonlyDenyReason(target) {
    return `${READONLY_DENY_MARKER} target "${target}" lies outside the writable set: read-only mode permits no file writes. `
        + 'Retry with the `sandbox_permissions` argument and a justification only when the write is genuinely required; '
        + 'the retry asks for approval.';
}
/**
 * Register the pre-execute gate.
 * @param ctx - Cordis context carrying `ctx.sandboxPolicy` (declared by `inject`).
 * @param config - validated plugin config.
 */
function apply(ctx, config) {
    const logger = ctx.logger('userspace-gate');
    ctx.on('tools/pre-execute', async (exec, next) => {
        const policy = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
        if (carriesEscalation(exec))
            return next();
        if (policy.mode === 'read-only') {
            // The filesystem fence owns read-only where it is mounted; in
            // fence-less compositions this guard restores the read-only rule
            // for the fs tools too (shell tools are covered by the
            // readonly-gate).
            const args = exec.arguments;
            const filePath = args !== null && typeof args === 'object' ? args.file_path : undefined;
            if (config.fsTools?.includes(exec.name) && typeof filePath === 'string' && filePath.length > 0) {
                logger.warn(`denied ${exec.name} call targeting "${filePath}" (session sandbox mode: read-only)`);
                return { kind: 'deny', reason: readonlyDenyReason(filePath) };
            }
            return next();
        }
        if (policy.mode !== 'workspace-write')
            return next();
        const targets = extractTargets(exec, config, policy);
        if (targets.length === 0)
            return next();
        const violation = await firstUncontainedTarget(targets.map(target => target.path), policy, config.shellTools?.includes(exec.name) ?? false);
        if (violation === undefined)
            return next();
        logger.warn(`denied ${exec.name} call targeting "${violation}" (session sandbox mode: workspace-write)`);
        return { kind: 'deny', reason: denyReason(violation) };
    });
}
//#endregion
export { Config, DENY_MARKER, READONLY_DENY_MARKER, apply, inject, name };
