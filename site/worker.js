// Minimal static-assets Worker: everything is served from env.ASSETS.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
