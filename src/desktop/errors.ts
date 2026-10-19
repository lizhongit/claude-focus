export class DesktopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopError";
  }
}
