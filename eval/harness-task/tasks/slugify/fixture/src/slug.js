export function slugify(input, options = {}) {
  const separator = options.separator ?? "-";
  let slug = String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^${separator}+|${separator}+$`, "g"), "");

  if (options.maxLength && slug.length > options.maxLength) {
    slug = slug.slice(0, options.maxLength);
  }

  return slug;
}
