/**
 * Body-parser mounting for the Showcase start route.
 *
 * ORDER IS THE WHOLE POINT OF THIS MODULE.
 *
 * `app.use(express.json())` is registered near the top of server/index.js and
 * defaults to a 100 kb limit. Express runs middleware in registration order, so
 * a route-level `express.json({ limit })` attached further down NEVER GETS THE
 * CHANCE TO RUN for an oversized body: the global parser reads the stream first,
 * throws `entity.too.large`, and the request is handed to the error handler
 * before it reaches the route.
 *
 * That is why a scoped parser declared alongside the route looked correct and
 * was not. It has to be mounted BEFORE the global one.
 *
 * Exported as a function rather than inlined so the ordering contract is a real
 * code path a test can exercise, instead of something asserted about a file that
 * binds a port on import.
 */

import { SHOWCASE_BODY_LIMIT_BYTES } from "./collectors/showcaseLimits.js";

/** Path prefix whose bodies may exceed the global limit. */
export const SHOWCASE_START_PATH = "/api/sparks/:id/llm/showcase";

/**
 * Mount the Showcase-scoped JSON parser.
 *
 * MUST be called before `app.use(express.json())`. Scoped to one path so the
 * rest of the API keeps the small default — raising every route to tens of MiB
 * would turn a body limit into a denial-of-service surface.
 *
 * @param {import("express").Express} app
 * @param {typeof import("express")} express
 */
export function mountShowcaseBodyParser(app, express) {
  app.use(SHOWCASE_START_PATH, express.json({ limit: SHOWCASE_BODY_LIMIT_BYTES }));
}

/**
 * Translate a body-parser failure into a sanitized response.
 *
 * `entity.too.large` becomes a 413 that names the limit and nothing else. The
 * body is never echoed and never logged: an oversized Showcase body is a prompt,
 * and a prompt is a manuscript.
 *
 * @returns {import("express").ErrorRequestHandler}
 */
export function showcaseBodyErrorHandler() {
  return (err, req, res, next) => {
    if (!err || res.headersSent) return next(err);
    const isBodyError =
      err.type === "entity.too.large" ||
      err.type === "entity.parse.failed" ||
      err.status === 413 ||
      err.statusCode === 413;
    if (!isBodyError) return next(err);

    if (err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Showcase request body is not valid JSON." });
    }
    return res.status(413).json({
      error:
        `Showcase request body exceeds the configured limit of ` +
        `${SHOWCASE_BODY_LIMIT_BYTES.toLocaleString()} bytes.`,
    });
  };
}
