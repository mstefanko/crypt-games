/** Byte count of canonical, semantically validated checkpoint data. This is not
 * JSON.stringify's lossy object conversion: undefined/functions are invalid here,
 * just as they are in the checkpoint schema. External bytes still use boundedJSON.
 * Keeping this separate permits byte-for-byte tests without exposing a runtime API. */
export function checkpointSize(value: unknown): number {
  const quotedSize = (value: string): number => {
    let size = 2;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (
        code === 34 ||
        code === 92 ||
        (code >= 8 && code <= 10) ||
        code === 12 ||
        code === 13
      )
        size += 2;
      else if (code < 32) size += 6;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (
        code >= 55296 &&
        code <= 56319 &&
        value.charCodeAt(i + 1) >= 56320 &&
        value.charCodeAt(i + 1) <= 57343
      ) {
        size += 4;
        i++;
      } else if (code >= 55296 && code <= 57343) size += 6;
      else size += 3;
    }
    return size;
  };
  let bytes = 0;
  const add = (size: number) => {
    bytes += size;
    if (bytes > 2097152) throw Error("JSON byte limit exceeded");
  };
  const visit = (value: unknown): void => {
    if (value === null) add(4);
    else if (typeof value === "string") add(quotedSize(value));
    else if (typeof value === "boolean") add(value ? 4 : 5);
    else if (typeof value === "number" && Number.isFinite(value))
      add(String(value).length);
    else if (Array.isArray(value)) {
      add(2 + Math.max(0, value.length - 1));
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const keys = Object.keys(object);
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        add(quotedSize(key) + 1);
        visit(object[key]);
      }
    } else throw Error("Checkpoint requires JSON data");
  };
  visit(value);
  return bytes;
}
