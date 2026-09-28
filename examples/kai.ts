// Starts @hanzo/mcp over stdio as an MCP client does, lists its kai tools and calls kai_choice once.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = (process.env.MCP_SERVER ?? "npx -y @hanzo/mcp serve").split(" ");
const transport = new StdioClientTransport({ command, args, env: { HANZO_API_KEY: process.env.HANZO_API_KEY ?? "" } });
const client = new Client({ name: "kai-docs", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(tools.map((tool) => tool.name).filter((name) => name.startsWith("kai_")).join(", "));

const result = await client.callTool({
  name: "kai_choice",
  arguments: {
    state: "I was charged twice for my March invoice and the second charge is still pending.",
    instructions: "Which team should handle this ticket?",
    criteria: {
      billing: "charges, invoices and refunds",
      technical: "bugs, errors and outages",
      account: "logins and profiles",
    },
  },
});
console.log((result.content as { type: string; text: string }[])[0].text);
await client.close();
