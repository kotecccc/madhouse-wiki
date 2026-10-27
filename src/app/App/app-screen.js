export function screenFromHash(hash) {
  return ["#raids", "#inventory", "#friends"].includes(hash)
    ? hash.slice(1)
    : "overview";
}
