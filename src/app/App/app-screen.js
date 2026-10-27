export function screenFromHash(hash) {
  return ["#raids", "#inventory", "#friends", "#queue"].includes(hash)
    ? hash.slice(1)
    : "overview";
}
