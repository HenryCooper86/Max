import { defineTool, defineTools } from "../../server/tools";

export default defineTools([
  defineTool({
    name: "echo_tool",
    description: "Echoes its arguments.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: (args) => ({ echoed: args.text })
  }),
  defineTool({
    name: "  spaced_ok  ",
    description: "  Name gets trimmed.  ",
    handler: () => "ok"
  }),
  { name: "bad name!", description: "invalid", handler: () => "x" },
  { name: "no_handler", description: "missing handler" } as never
]);
