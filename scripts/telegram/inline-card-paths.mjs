export function normalizeInlineCode(value) {
  return String(value || "")
    .toLocaleUpperCase("ru-RU")
    .replaceAll("С", "C");
}

function codeSlug(value) {
  const code = normalizeInlineCode(value);
  return code === "$" ? "special" : code.replace(/[^A-Z0-9_-]/g, "-");
}

export function floorCardFilename(code) {
  return `floor-${codeSlug(code)}.jpg`;
}

export function departmentCardFilename(code) {
  return `department-${codeSlug(code)}.jpg`;
}
