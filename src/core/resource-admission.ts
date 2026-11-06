// Shared by every endpoint. A reservation lasts until its process group or
// upstream transport has finished cleanup.
export class ResourceAdmission {
  private used = 0;

  constructor(private readonly limit: number) {}

  acquire(): ResourceLease | undefined {
    if (this.used >= this.limit) return undefined;
    this.used++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.used--;
      },
    };
  }
}

export interface ResourceLease {
  release(): void;
}
