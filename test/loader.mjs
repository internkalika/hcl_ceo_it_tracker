// Test-only module hook: resolve "@vercel/blob" to the strict in-memory fake.
export async function resolve(specifier, context, next) {
  if (specifier === "@vercel/blob") return { url: new URL("./fake-blob.mjs", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
