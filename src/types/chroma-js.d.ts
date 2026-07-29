// Minimal ambient declaration for the small chroma-js surface this plugin uses,
// to avoid coupling to a specific @types/chroma-js major that may lag the runtime.
declare module "chroma-js" {
  interface Scale {
    colors(n: number): string[];
  }
  interface Chroma {
    scale(name?: string | string[]): Scale;
  }
  const chroma: Chroma;
  export default chroma;
}
