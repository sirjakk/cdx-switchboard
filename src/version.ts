import fs from "node:fs";

/** The package version, read from the package.json shipped beside dist/. */
export const VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
