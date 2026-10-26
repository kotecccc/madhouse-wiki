export function screenFromHash(hash) {
  return ["#raids", "#inventory"].includes(hash) ? hash.slice(1) : "overview";
}
