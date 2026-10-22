export const BLOCK_SECTIONS = ["requirements", "works", "bosses", "businesses"];
export const BLOCK_SECTION_LABELS = {
  requirements: "Условия открытия",
  works: "Работы",
  bosses: "Боссы",
  businesses: "Бизнесы",
};
export function normalizeBlockSections(value, includeMissing = false) {
  const result = [
    ...new Set(
      (Array.isArray(value) ? value : []).filter((key) =>
        BLOCK_SECTIONS.includes(key),
      ),
    ),
  ];
  return includeMissing
    ? [...result, ...BLOCK_SECTIONS.filter((key) => !result.includes(key))]
    : result;
}
