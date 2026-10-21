export function strongBlobEtag(etag) {
  if (typeof etag !== "string" || !etag)
    throw new Error("raid_blob_etag_unavailable");
  return etag.replace(/^W\//, "");
}
