declare module "pngjs" {
  export class PNG {
    static sync: {
      read(buffer: Buffer): { data: Buffer; width: number; height: number }
      write(png: { data: Buffer; width: number; height: number }): Buffer
    }
  }
}

declare module "jpeg-js" {
  export function decode(
    buffer: Buffer,
    opts?: { useTArray?: boolean; maxMemoryUsageInMB?: number },
  ): { data: Uint8Array; width: number; height: number }
  export function encode(
    image: { data: Uint8Array | Buffer; width: number; height: number },
    quality?: number,
  ): { data: Buffer }
}
