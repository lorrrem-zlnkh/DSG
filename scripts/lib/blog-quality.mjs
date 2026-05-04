const BLOCKED_BLOG_URLS = new Set([
  "https://habr.com/ru/articles/1027678",
]);

const BLOCKED_BLOG_TITLE_PATTERNS = [
  /сделай\s+красиво.+это\s+не\s+промт.+бренд-платформа\s+за\s+8\s+часов/i,
];

function normalizeBlockedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return String(value || "").trim().replace(/\/$/, "");
  }
}

export function isBlockedBlogPost(post) {
  const url = normalizeBlockedUrl(post?.url);
  if (url && BLOCKED_BLOG_URLS.has(url)) return true;

  const title = String(post?.title || post?.sourceTitle || "");
  return BLOCKED_BLOG_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}
