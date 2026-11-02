import { UserError, type JsonSchema } from "./types.ts";

/**
 * Validator ketat untuk argumen tool. Sengaja kecil dan tanpa dependensi.
 * Menolak properti yang tidak dikenal, tipe salah, string terlalu panjang, dsb.
 */
export function validate(schema: JsonSchema, value: unknown, path = "argumen"): void {
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new UserError(`${path} harus berupa objek.`);
      }
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined || obj[key] === null) throw new UserError(`${path}.${key} wajib diisi.`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = Object.prototype.hasOwnProperty.call(props, key) ? props[key] : undefined;
        if (!sub) {
          if (schema.additionalProperties === false) throw new UserError(`${path}.${key} tidak dikenal.`);
          continue;
        }
        if (v === undefined || v === null) continue;
        validate(sub, v, `${path}.${key}`);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") throw new UserError(`${path} harus berupa teks.`);
      if (schema.minLength !== undefined && value.length < schema.minLength)
        throw new UserError(`${path} minimal ${schema.minLength} karakter.`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        throw new UserError(`${path} maksimal ${schema.maxLength} karakter.`);
      if (schema.enum && !schema.enum.includes(value))
        throw new UserError(`${path} harus salah satu dari: ${schema.enum.join(", ")}.`);
      if (schema.pattern && !new RegExp(schema.pattern).test(value))
        throw new UserError(`${path} formatnya tidak valid.`);
      if (schema.format === "https-url") assertHttpsUrl(value, path);
      return;
    }
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new UserError(`${path} harus berupa angka.`);
      if (schema.type === "integer" && !Number.isInteger(value)) throw new UserError(`${path} harus bilangan bulat.`);
      if (schema.minimum !== undefined && value < schema.minimum)
        throw new UserError(`${path} minimal ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum)
        throw new UserError(`${path} maksimal ${schema.maximum}.`);
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") throw new UserError(`${path} harus true atau false.`);
      return;
    case "array": {
      if (!Array.isArray(value)) throw new UserError(`${path} harus berupa daftar.`);
      if (schema.minItems !== undefined && value.length < schema.minItems)
        throw new UserError(`${path} minimal ${schema.minItems} item.`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        throw new UserError(`${path} maksimal ${schema.maxItems} item.`);
      if (schema.items) value.forEach((item, i) => validate(schema.items!, item, `${path}[${i}]`));
      return;
    }
  }
}

function assertHttpsUrl(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError(`${path} harus URL yang valid.`);
  }
  if (url.protocol !== "https:") throw new UserError(`${path} harus memakai https.`);
  if (url.username || url.password) throw new UserError(`${path} tidak boleh berisi kredensial.`);
}

/** Skema untuk tampilan ke klien: buang kata kunci internal (format kustom). */
export function publicSchema(schema: JsonSchema): Record<string, unknown> {
  const { format, properties, items, ...rest } = schema;
  const out: Record<string, unknown> = { ...rest };
  if (format === "https-url") out.format = "uri";
  if (format === "date-time") out.format = "date-time";
  if (properties) {
    out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, publicSchema(v)]));
  }
  if (items) out.items = publicSchema(items);
  return out;
}
