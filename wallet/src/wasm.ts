// Hand-written glue for the core modules' C ABI (core/abi): no wasm-bindgen, no generated JS.
//
// Every module exports `memory`, `alloc`, `dealloc`, `out_ptr`, `out_len` and `out_clear`. A call
// passes byte inputs as (ptr, len) pairs and numbers as u32, returns 0 (result bytes) or 1 (UTF-8
// error message), and leaves the bytes in one result buffer until the next call.

/** What a call takes: text (UTF-8), bytes, or a u32. */
export type CoreArg = string | Uint8Array | number;

/** A module function reported an error (bad input, invalid phrase, ...). */
export class CoreModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreModuleError";
  }
}

interface AbiExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  out_ptr(): number;
  out_len(): number;
  out_clear(): void;
}

/** One instantiated core module. Modules import nothing, so instantiation needs no imports. */
export class CoreModule {
  private constructor(private readonly exports: AbiExports & Record<string, unknown>) {}

  static async instantiate(bytes: BufferSource): Promise<CoreModule> {
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new CoreModule(instance.exports as unknown as AbiExports & Record<string, unknown>);
  }

  /** Calls `name` and returns its result bytes; throws CoreModuleError on an error result. */
  call(name: string, ...args: CoreArg[]): Uint8Array {
    const fn = this.exports[name];
    if (typeof fn !== "function") throw new Error(`core module has no export ${name}`);
    const x = this.exports;
    const inputs: [number, number][] = [];
    const raw: number[] = [];
    try {
      for (const arg of args) {
        if (typeof arg === "number") {
          raw.push(arg >>> 0);
          continue;
        }
        const bytes = typeof arg === "string" ? new TextEncoder().encode(arg) : arg;
        const ptr = x.alloc(bytes.length);
        new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
        inputs.push([ptr, bytes.length]);
        raw.push(ptr, bytes.length);
      }
      const status = (fn as (...a: number[]) => number)(...raw);
      // Copy out before anything else touches memory (it may grow and detach old views).
      const out = new Uint8Array(x.memory.buffer, x.out_ptr(), x.out_len()).slice();
      x.out_clear();
      if (status !== 0) throw new CoreModuleError(new TextDecoder().decode(out));
      return out;
    } finally {
      // Inputs can be secrets (a Master Mnemonic, a password): zero them before freeing.
      for (const [ptr, len] of inputs) {
        new Uint8Array(x.memory.buffer, ptr, len).fill(0);
        x.dealloc(ptr, len);
      }
    }
  }

  /** `call` for text results. */
  callText(name: string, ...args: CoreArg[]): string {
    return new TextDecoder().decode(this.call(name, ...args));
  }
}
