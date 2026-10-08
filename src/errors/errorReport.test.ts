import assert from "node:assert/strict";
import { it } from "node:test";
import { errorMessage, errorReport } from "./errorReport";

it("keeps the page pathname and error details without copying location query values", () => {
  const cause = new Error("Native connection failed");
  const error = new Error("Could not initialize", { cause });
  const report = errorReport({
    error,
    pathname: "/settings/general?token=private-value#private-fragment",
    version: "0.1.0",
    area: "Startup",
  });
  assert.ok(
    report.includes("Bot Code 0.1.0\nPath: /settings/general\nArea: Startup"),
  );
  assert.ok(report.includes("Could not initialize"));
  assert.ok(report.includes("Caused by:\nError: Native connection failed"));
  assert.equal(report.includes("private-value"), false);
  assert.equal(report.includes("private-fragment"), false);
});

it("bounds cyclic error causes so an error report can still render and copy", () => {
  const error = new Error("Repeated cause");
  error.cause = error;
  const report = errorReport({
    error,
    pathname: "/",
    version: "0.1.0",
    area: "Application",
  });
  assert.equal(report.split("Caused by:").length - 1, 5);
});

it("provides readable output for empty and unserializable thrown values", () => {
  assert.equal(errorMessage(undefined), "An unexpected error occurred.");
  assert.equal(errorMessage("  "), "An unexpected error occurred.");
  assert.equal(errorMessage("Runtime unavailable"), "Runtime unavailable");
  for (const error of [undefined, 1n]) {
    const report = errorReport({
      error,
      pathname: "/",
      version: "0.1.0",
      area: "Application",
    });
    assert.ok(report.endsWith("No additional error details are available."));
  }
});
