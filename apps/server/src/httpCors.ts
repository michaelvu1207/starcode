// `PUT` is the fork's addition, for `/api/usage/model-aliases` — the one route
// here that replaces a whole resource rather than appending to one. It grants
// nothing `POST` does not: every route behind this policy is scope-checked
// individually, and the origin allowlist is unchanged. Without it the browser
// refuses the preflight and the route is unreachable from the dev web origin.
export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
