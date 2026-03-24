// Type declarations za httpntlm paket koji nema @types
declare module "httpntlm" {
  interface NtlmOptions {
    url: string;
    username: string;
    password: string;
    domain: string;
    workstation: string;
    headers?: Record<string, string>;
    body?: string;
  }

  type NtlmCallback = (err: Error | null, res: { statusCode: number; statusMessage: string; body: string }) => void;

  export function get(options: NtlmOptions, callback: NtlmCallback): void;
  export function post(options: NtlmOptions, callback: NtlmCallback): void;
  // "delete" je reserved keyword — deklarira se kao property, poziva se kao httpntlm["delete"](...)
  const _delete: (options: NtlmOptions, callback: NtlmCallback) => void;
  export { _delete as delete };
}
