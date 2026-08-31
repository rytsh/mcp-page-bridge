import { mount } from "svelte";
import App from "./App.svelte";
import { registerMcpTools } from "./mcp";

const app = mount(App, { target: document.getElementById("app")! });

// Expose this app's tools to the agent (no-op without WebMCP support).
void registerMcpTools();

export default app;
