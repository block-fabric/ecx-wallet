// Build gate (spec story 47): a core module may import nothing but memory, so it structurally
// can't reach the network, storage, the DOM or a clock.
export function checkWasmImports(name, bytes) {
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).filter((i) => i.kind !== "memory");
  if (imports.length > 0) {
    const list = imports.map((i) => `${i.module}.${i.name} (${i.kind})`).join(", ");
    throw new Error(`${name} imports more than memory: ${list}`);
  }
}
