// Type declarations for optional dependencies
declare module '@lancedb/lancedb' {
  function connect(uri: string): Promise<any>;
  export default { connect };
}

declare module '@xenova/transformers' {
  export function pipeline(task: string, model: string): Promise<any>;
}
