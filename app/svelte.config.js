import adapter from "@sveltejs/adapter-static";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    // One static shell (index.html); every screen is a hash route, e.g. index.html#/approve/<id>.
    adapter: adapter({ pages: "build", assets: "build", fallback: undefined, strict: true }),
    router: { type: "hash" },
    // Chrome refuses to load extension files or directories whose name starts with "_".
    appDir: "kit",
    paths: { relative: true },
  },
};
