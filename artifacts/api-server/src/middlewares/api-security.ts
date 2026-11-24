import type { RequestHandler, Response } from "express";

const privateHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
} as const;
const protectedHeaders = new Set(
  Object.keys(privateHeaders).map((name) => name.toLowerCase()),
);

/** Install before authentication, workspace selection, parsers and platform routes. */
export const apiSecurity: RequestHandler = (req, res, next) => {
  if (!/^\/api(?:\/|$)/i.test(req.path)) {
    next();
    return;
  }
  res.set(privateHeaders);
  const writeHead = res.writeHead;
  // A file download, error handler or future route must not re-enable API caching.
  res.writeHead = function (this: Response, ...args: unknown[]) {
    const headersIndex = typeof args[1] === "string" ? 2 : 1;
    const headers = args[headersIndex];
    if (Array.isArray(headers)) {
      const safe: unknown[] = [];
      for (let index = 0; index < headers.length; index += 2) {
        if (!protectedHeaders.has(String(headers[index]).toLowerCase()))
          safe.push(headers[index], headers[index + 1]);
      }
      args[headersIndex] = safe;
    } else if (headers && typeof headers === "object") {
      args[headersIndex] = Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) => !protectedHeaders.has(name.toLowerCase()),
        ),
      );
    }
    this.set(privateHeaders);
    return Reflect.apply(writeHead, this, args);
  } as Response["writeHead"];
  next();
};
