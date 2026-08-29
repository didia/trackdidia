const hashString = (value: string): string => {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
};

export const buildAiInputHash = (parts: Record<string, unknown>): string =>
  hashString(JSON.stringify(parts));
