// Terminal error handling. Without this, an unhandled error reaches Express's default handler,
// which in a non-production NODE_ENV replies with an HTML page containing the full stack trace —
// file paths, line numbers, and whatever the error message happened to embed. The app expects
// JSON, so it also fails to parse whatever it gets and shows a generic failure instead of the real
// one.
//
// Express 5 forwards a rejected promise from an async route handler here on its own, so this
// catches the common case (an `await` that throws inside a controller) and not just sync throws.

const multer = require("multer");

/** Anything that reached the end of the router without matching a route. */
const notFound = (req, res) => {
  res.status(404).json({ message: `Cannot ${req.method} ${req.originalUrl}` });
};

/**
 * Maps the error shapes this app actually produces onto a status and a message that is safe to
 * send. Anything unrecognised is a 500 and gets a generic body — an unexpected error's message is
 * written for a developer, not a user, and may quote a query or a connection string.
 */
function classify(err) {
  // The specific shapes are checked before the generic `err.status` fallback: body-parser errors
  // carry a status *and* a raw parser message ("Unexpected end of JSON input"), so matching on
  // status first would pass that message straight through instead of a useful one.

  // express.json() on a malformed body. The client sent something wrong, not the server.
  if (err.type === "entity.parse.failed") return { status: 400, message: "Malformed JSON body" };
  if (err.type === "entity.too.large")    return { status: 413, message: "Request body too large" };

  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return { status: tooBig ? 413 : 400, message: tooBig ? "File too large" : "File upload rejected" };
  }

  if (err.name === "ValidationError") {
    // Mongoose schema validation — the field names are the client's own input.
    const detail = Object.values(err.errors || {}).map((e) => e.message).join("; ");
    return { status: 400, message: detail || "Validation failed" };
  }
  if (err.name === "CastError") {
    return { status: 400, message: `Invalid ${err.path}` };
  }
  if (err.code === 11000) {
    return { status: 409, message: "That already exists" };
  }
  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return { status: 401, message: "Not authorized" };
  }

  // A status the thrower set deliberately, with the message they wrote for the client.
  if (err.status || err.statusCode) {
    return { status: err.status || err.statusCode, message: err.message || "Request failed" };
  }

  return { status: 500, message: "Something went wrong" };
}

// eslint-disable-next-line no-unused-vars -- Express identifies an error handler by its arity.
const errorHandler = (err, req, res, next) => {
  // Once a response has started there is nothing useful left to say; Express's default handler
  // aborts the connection, which is the only correct move.
  if (res.headersSent) return next(err);

  const { status, message } = classify(err);

  // Log server-side regardless of what the client is told — a 500 with a generic body is invisible
  // otherwise. 4xx is the client's mistake and only worth a line.
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}`, err);
  } else {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  res.status(status).json({ message });
};

module.exports = { notFound, errorHandler };
