import {
  parseDocx
} from "./chunk-XBI2PYTU.js";
import {
  buildDocModel
} from "./chunk-P3MKA55V.js";
import {
  setWasmSource
} from "./chunk-WKBPLHUA.js";

// src/docx-import-worker.ts
function performanceNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: String(error)
  };
}
self.addEventListener(
  "message",
  async (event) => {
    const request = event.data;
    if (!request || request.type !== "import-docx") {
      return;
    }
    try {
      if (request.wasmSource !== void 0) {
        setWasmSource(request.wasmSource);
      }
      const startedAt = performanceNow();
      const pkg = await parseDocx(request.buffer);
      const parsedAt = performanceNow();
      const model = await buildDocModel(pkg);
      const finishedAt = performanceNow();
      const timings = {
        totalMs: finishedAt - startedAt,
        parseMs: parsedAt - startedAt,
        buildModelMs: finishedAt - parsedAt
      };
      const response = {
        id: request.id,
        type: "success",
        package: pkg,
        model,
        timings
      };
      self.postMessage(response);
    } catch (error) {
      const response = {
        id: request.id,
        type: "error",
        error: serializeError(error)
      };
      self.postMessage(response);
    }
  }
);
//# sourceMappingURL=docx-import-worker.js.map