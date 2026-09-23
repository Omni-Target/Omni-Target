export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const dns = await import("node:dns");
      dns.setDefaultResultOrder("ipv4first");
    } catch {}

    try {
      const { Agent, setGlobalDispatcher } = await import("undici");
      setGlobalDispatcher(
        new Agent({
          connect: {
            family: 4,
          },
        })
      );
    } catch (e) {
      console.error("Failed to set undici global dispatcher in instrumentation:", e);
    }
  }
}
